// OAuth discovery — one `BOARDWALK_ISSUER_URL` resolves BOTH the authorize page and the token
// endpoint, which live on different hosts in Boardwalk's self-hosted OAuth server (the themed consent
// page on the web app, the token exchange on the api-server). The CLI fetches the RFC 8414 metadata
// document and reads `authorization_endpoint` + `token_endpoint` from it.

import { CliError } from "../errors.js";
import type { FetchLike } from "./pkce.js";

const DISCOVERY_PATH = "/.well-known/oauth-authorization-server";
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface OAuthDiscovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** Fetch + parse the issuer's OAuth Authorization Server Metadata. Throws `CliError` (actionable) on
 *  an unreachable endpoint, a non-2xx, a non-JSON body, or a document missing the two endpoints. */
export async function discoverOAuth(
  issuerUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<OAuthDiscovery> {
  const url = `${issuerUrl.replace(/\/+$/, "")}${DISCOVERY_PATH}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CliError(
      `Could not reach the OAuth discovery endpoint (${url}).`,
      err instanceof Error ? err.message : undefined,
    );
  }

  if (!res.ok) {
    throw new CliError(
      `OAuth discovery failed (${String(res.status)}) at ${url}.`,
      "Check BOARDWALK_ISSUER_URL (or BOARDWALK_API_DOMAIN) points at a Boardwalk deployment.",
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new CliError("OAuth discovery returned a non-JSON body.");
  }

  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const authorizationEndpoint = b.authorization_endpoint;
  const tokenEndpoint = b.token_endpoint;
  if (typeof authorizationEndpoint !== "string" || authorizationEndpoint.length === 0) {
    throw new CliError("OAuth discovery document is missing an authorization_endpoint.");
  }
  if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
    throw new CliError("OAuth discovery document is missing a token_endpoint.");
  }
  return { authorizationEndpoint, tokenEndpoint };
}
