// OAuth 2.0 Authorization Code + PKCE — the primitives `boardwalk login` runs against the
// platform's identity provider (an internal detail; the CLI only knows the issuer URL).
//
// Notable adaptations for this IdP:
//   - The backend has no OAuth authorization server of its own (it only VERIFIES issued JWTs via
//     JWKS), so we authenticate directly against the issuer's `/oauth/authorize` + `/oauth/token`.
//   - No RFC 7591 dynamic client registration → the public client id is pre-provisioned (an OAuth
//     application) and supplied via config, not registered on the fly.
//   - The redirect allowlist wants exact URIs → we use a FIXED loopback port (config), not an
//     ephemeral one. RFC 8707 resource indicators are dropped (single audience: the session).
//
// The pure pieces (pair/state/URL/exchange/refresh/expiry) are unit-tested with an injected fetch;
// the loopback server + browser open are exercised by the login command, not unit tests.

import { randomBytes, createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CliError } from "../errors.js";

export type FetchLike = typeof fetch;

const CALLBACK_PATH = "/callback";
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;
const CALLBACK_TIMEOUT_MS = 180_000;
/** Treat a token as expired this long BEFORE its true expiry, to avoid using it mid-flight. */
const EXPIRY_GRACE_MS = 30_000;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A 48-byte verifier (base64url) + its S256 challenge. */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest().toString("base64url");
  return { verifier, challenge };
}

/** Opaque CSRF state (random UUID, hyphens stripped). */
export function randomState(): string {
  return randomUUID().replace(/-/g, "");
}

export interface OAuthEndpoints {
  authorize: string;
  token: string;
}

/** The issuer's OAuth2 endpoints, derived from the issuer origin. */
export function oauthEndpoints(issuerUrl: string): OAuthEndpoints {
  const base = issuerUrl.replace(/\/+$/, "");
  return { authorize: `${base}/oauth/authorize`, token: `${base}/oauth/token` };
}

export interface AuthorizeUrlParams {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
}

export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    state: p.state,
    scope: p.scope,
  });
  return `${p.authorizeEndpoint}?${params.toString()}`;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry epoch ms, or null when the IdP didn't return `expires_in`. */
  expiresAt: number | null;
  scope: string | null;
}

export interface ExchangeCodeParams {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike | undefined;
  now?: number | undefined;
}

export async function exchangeCode(p: ExchangeCodeParams): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.codeVerifier,
    redirect_uri: p.redirectUri,
  });
  return postToken(p.tokenEndpoint, form, p.fetchImpl, p.now);
}

export interface RefreshParams {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  fetchImpl?: FetchLike | undefined;
  now?: number | undefined;
}

export async function refreshAccessToken(p: RefreshParams): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: p.clientId,
    refresh_token: p.refreshToken,
  });
  return postToken(p.tokenEndpoint, form, p.fetchImpl, p.now);
}

/** True when `expiresAt` is within the grace window of `now` (or already past). Null = never. */
export function isExpired(expiresAt: number | null, now: number = Date.now()): boolean {
  if (expiresAt === null) return false;
  return now >= expiresAt - EXPIRY_GRACE_MS;
}

async function postToken(
  tokenEndpoint: string,
  form: URLSearchParams,
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CliError(
      `Could not reach the token endpoint (${tokenEndpoint}).`,
      err instanceof Error ? err.message : undefined,
    );
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new CliError(`Token request failed (${String(res.status)}).`, oauthErrorDetail(bodyText));
  }
  return parseTokenBody(bodyText, now);
}

function parseTokenBody(bodyText: string, now: number): TokenResponse {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new CliError("Token endpoint returned a non-JSON body.");
  }
  if (typeof body !== "object" || body === null) {
    throw new CliError("Token endpoint returned an unexpected body.");
  }
  const b = body as Record<string, unknown>;
  const accessToken = b.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new CliError("Token endpoint response is missing an access_token.");
  }
  const expiresIn = typeof b.expires_in === "number" ? b.expires_in : null;
  return {
    accessToken,
    refreshToken: typeof b.refresh_token === "string" ? b.refresh_token : null,
    expiresAt: expiresIn !== null ? now + expiresIn * 1000 : null,
    scope: typeof b.scope === "string" ? b.scope : null,
  };
}

/** Best-effort `error_description`/`error` from an OAuth error body, for the hint line. */
function oauthErrorDetail(bodyText: string): string | undefined {
  try {
    const body: unknown = JSON.parse(bodyText);
    if (typeof body === "object" && body !== null) {
      const b = body as Record<string, unknown>;
      const detail = b.error_description ?? b.error;
      if (typeof detail === "string" && detail.length > 0) return detail;
    }
  } catch {
    // not JSON — fall through
  }
  return bodyText.length > 0 ? bodyText.slice(0, 200) : undefined;
}

export interface Loopback {
  redirectUri: string;
  port: number;
  /** Resolves with the authorization `code` once the browser redirects back (validates `state`). */
  awaitCode(expectedState: string): Promise<string>;
  close(): void;
}

/**
 * Start a localhost callback server on the fixed `port`. The redirect URI it advertises must be
 * allowlisted on the OAuth application.
 */
export async function startLoopback(port: number): Promise<Loopback> {
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";
    const expectedState = pendingState;

    let message: string;
    if (error.length > 0) {
      message = `Authorization failed: ${error}`;
      rejectCode(new CliError(message));
    } else if (code.length === 0) {
      message = "Authorization failed: no code in the callback.";
      rejectCode(new CliError(message));
    } else if (expectedState === null || state !== expectedState) {
      message = "Authorization failed: state mismatch (possible CSRF).";
      rejectCode(new CliError(message));
    } else {
      message = "Boardwalk login complete — you can close this tab and return to the terminal.";
      resolveCode(code);
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
  });

  let pendingState: string | null = null;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    redirectUri: `http://127.0.0.1:${String(port)}${CALLBACK_PATH}`,
    port,
    awaitCode(expectedState: string): Promise<string> {
      pendingState = expectedState;
      const timeout = new Promise<string>((_resolve, reject) => {
        const t = setTimeout(() => {
          reject(new CliError("Timed out waiting for the browser authorization (3 min)."));
        }, CALLBACK_TIMEOUT_MS);
        t.unref();
      });
      return Promise.race([codePromise, timeout]);
    },
    close(): void {
      server.close();
    },
  };
}
