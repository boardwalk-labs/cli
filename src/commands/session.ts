// SPDX-License-Identifier: MIT

// `boardwalk login` / `logout` / `whoami` — session lifecycle.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { performLogin } from "../auth/login.js";
import { resolveLog } from "../log.js";

export interface SessionDeps {
  config: CliConfig;
  log?: (line: string) => void;
}

export interface LoginOptions {
  /** Persist this API key (`bwk_…`) instead of running the browser PKCE flow. */
  token?: string | undefined;
  /** Scope tier: `admin` authenticates against the elevated CLI client to obtain the org-admin
   *  write scopes (secrets, inference providers, workflow delete). Omitted ⇒ the least-privilege
   *  default login. The only recognized value is `admin`. */
  scopes?: string | undefined;
}

/** The elevated CLI client id for `--scopes admin` — the `-admin` sibling of the configured client
 *  (e.g. `boardwalk-cli` → `boardwalk-cli-admin`), registered in the backend's OAuth client list. */
function adminClientId(config: CliConfig): string | null {
  return config.oauthClientId === null ? null : `${config.oauthClientId}-admin`;
}

export async function runLogin(deps: SessionDeps, opts: LoginOptions = {}): Promise<void> {
  const log = resolveLog(deps);
  const store = CredentialStore.atConfigDir(deps.config.configDir);

  // First-class API-key auth: `boardwalk login --token <key>` stores the key like a
  // non-expiring, non-refreshable session, so every command resolves it without re-setting
  // BOARDWALK_API_KEY. (Not validated here — the first request rejects a bad key.) The two
  // non-interactive paths (env BOARDWALK_API_KEY, --token per command) still work too.
  const token = opts.token?.trim();
  if (token !== undefined && token.length > 0) {
    store.putSession({
      accessToken: token,
      refreshToken: null,
      expiresAt: null,
      clientId: null,
      tokenEndpoint: null,
      scope: "api-key",
    });
    log("✓ Stored API key.");
    return;
  }

  const tier = opts.scopes?.trim();
  if (tier !== undefined && tier.length > 0 && tier !== "admin") {
    throw new CliError(`Unknown --scopes "${tier}".`, "The only elevated tier is `admin`.");
  }
  const elevated = tier === "admin";
  let clientIdOverride: string | undefined;
  if (elevated) {
    const adminId = adminClientId(deps.config);
    if (adminId === null) {
      throw new CliError(
        "No OAuth client id configured, so `--scopes admin` can't resolve the elevated client.",
        "Set BOARDWALK_OAUTH_CLIENT_ID (the elevated client is its `-admin` sibling).",
      );
    }
    clientIdOverride = adminId;
    log("Requesting an ELEVATED session (secrets + inference providers + workflow delete).");
  }

  const session = await performLogin({
    config: deps.config,
    store,
    log,
    ...(clientIdOverride !== undefined ? { clientIdOverride } : {}),
  });
  const expiry =
    session.expiresAt !== null ? ` (expires ${new Date(session.expiresAt).toISOString()})` : "";
  log(`✓ Logged in${elevated ? " (elevated)" : ""}.${expiry}`);
}

export function runLogout(deps: SessionDeps): void {
  const log = resolveLog(deps);
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  store.clear();
  log("✓ Logged out — local credentials removed.");
}

/** Report whether a stored session exists. (Identity claims live in the JWT; v0 keeps this minimal.) */
export function runWhoami(deps: SessionDeps): void {
  const log = resolveLog(deps);
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const session = store.getSession();
  if (session === null) {
    throw new CliError(
      "Not logged in.",
      "Run `boardwalk login` (or `boardwalk login --token <key>`).",
    );
  }
  // A stored API key has no token endpoint / refresh token; an OAuth session does.
  const method = session.tokenEndpoint === null ? "API key" : "OAuth session";
  const scope = session.scope ?? "(none)";
  const expiry = session.expiresAt !== null ? new Date(session.expiresAt).toISOString() : "never";
  log(`Logged in via ${method}. scope=${scope} expires=${expiry}`);
}
