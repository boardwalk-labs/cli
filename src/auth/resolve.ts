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
import type { CredentialStore } from "../credentials.js";
import { isExpired, refreshAccessToken, type FetchLike } from "./pkce.js";

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
