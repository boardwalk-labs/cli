// SPDX-License-Identifier: MIT

// resolveToken — the single place a command turns "the user" into a Bearer token.
//
// Precedence (highest first):
//   1. an explicit `--token` flag (one-off / scripting)
//   2. `BOARDWALK_API_KEY` env (CI / headless — a `bwk_…` key)
//   3. the stored `boardwalk login` session — refreshed in place when expired
//
// Throws `CliError` (actionable) when none is available or a refresh can't proceed.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { CredentialStore, StoredSession } from "../credentials.js";
import { isExpired, refreshAccessToken, type FetchLike } from "./pkce.js";

/** A resolved API target: the Bearer token + the base URL to send it to (kept consistent). */
export interface ApiTarget {
  token: string;
  baseUrl: string;
}

/** Where the resolved base URL came from. `explicit` = a BOARDWALK_API_URL/DOMAIN override;
 *  `session` = the stored login's own API origin; `default` = the prod fallback. */
export type BaseUrlSource = "explicit" | "session" | "default";

/** A resolved base URL + how it was chosen (for diagnostics like `boardwalk status`). */
export interface ResolvedBaseUrl {
  url: string;
  source: BaseUrlSource;
}

/**
 * Decide which API base to use, by precedence (pure — no IO, so `status` and `resolveApiTarget`
 * agree exactly):
 *   1. an explicit env override (`config.apiBaseExplicit`)
 *   2. the stored session's own API origin — only when the credential IS that session (a `--token`
 *      flag or `BOARDWALK_API_KEY` is host-agnostic and follows the env/default)
 *   3. the config default (prod)
 */
export function resolveBaseUrl(opts: {
  config: CliConfig;
  session: StoredSession | null;
  usingFlag: boolean;
  usingEnvKey: boolean;
}): ResolvedBaseUrl {
  if (opts.config.apiBaseExplicit === true)
    return { url: opts.config.apiBaseUrl, source: "explicit" };
  if (!opts.usingFlag && !opts.usingEnvKey) {
    const origin = sessionApiOrigin(opts.session);
    if (origin !== null) return { url: origin, source: "session" };
  }
  return { url: opts.config.apiBaseUrl, source: "default" };
}

/** The API origin a session authenticates against, derived from its token endpoint
 *  (`https://<api-host>/oauth/token` → `https://<api-host>`). Null when unknown/unparseable. */
export function sessionApiOrigin(session: StoredSession | null): string | null {
  if (session?.tokenEndpoint == null) return null;
  try {
    return new URL(session.tokenEndpoint).origin;
  } catch {
    return null;
  }
}

export interface ResolveTokenDeps {
  config: CliConfig;
  store: CredentialStore;
  tokenFlag?: string | undefined;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  now?: number;
}

export async function resolveToken(deps: ResolveTokenDeps): Promise<string> {
  const env = deps.env ?? process.env;

  // 1. explicit --token
  const flag = deps.tokenFlag?.trim();
  if (flag !== undefined && flag.length > 0) return flag;

  // 2. env API key (CI)
  const envKey = env.BOARDWALK_API_KEY?.trim();
  if (envKey !== undefined && envKey.length > 0) return envKey;

  // 3. stored login session
  const session = deps.store.getSession();
  if (session === null) {
    throw new CliError("Not authenticated.", "Run `boardwalk login`, or set BOARDWALK_API_KEY.");
  }
  if (!isExpired(session.expiresAt, deps.now)) return session.accessToken;

  // expired → refresh in place
  if (
    session.refreshToken === null ||
    session.tokenEndpoint === null ||
    session.clientId === null
  ) {
    throw new CliError("Your session has expired.", "Run `boardwalk login` again.");
  }
  const refreshed = await refreshAccessToken({
    tokenEndpoint: session.tokenEndpoint,
    clientId: session.clientId,
    refreshToken: session.refreshToken,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
  });
  deps.store.putSession({
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken ?? session.refreshToken,
    expiresAt: refreshed.expiresAt,
    clientId: session.clientId,
    tokenEndpoint: session.tokenEndpoint,
    scope: refreshed.scope ?? session.scope,
  });
  return refreshed.accessToken;
}

/**
 * Resolve BOTH the Bearer token AND the API base to send it to, kept consistent. Base precedence:
 *   1. an explicit env override (`config.apiBaseExplicit`) — always wins
 *   2. the stored session's own API origin — ONLY when the token came from that session (not a
 *      `--token` flag or a `BOARDWALK_API_KEY`, which are host-agnostic and follow the env/default)
 *   3. the config default (prod)
 *
 * The point: after `boardwalk login` against a dev / self-host stack, every authenticated command
 * talks to THAT stack without the user re-exporting `BOARDWALK_API_URL` on each call.
 */
export async function resolveApiTarget(deps: ResolveTokenDeps): Promise<ApiTarget> {
  const env = deps.env ?? process.env;
  const token = await resolveToken(deps);
  const { url } = resolveBaseUrl({
    config: deps.config,
    session: deps.store.getSession(),
    usingFlag: (deps.tokenFlag ?? "").trim().length > 0,
    usingEnvKey: (env.BOARDWALK_API_KEY ?? "").trim().length > 0,
  });
  return { token, baseUrl: url };
}
