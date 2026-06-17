// SPDX-License-Identifier: MIT

// Managed-inference wiring for `boardwalk dev`.
//
// The north star: install → login → `agent()` works locally, no
// keys to paste. The embedded engine's default `boardwalk` provider reaches the hosted inference
// gateway using a short-lived, inference-ONLY key minted from the login session. This module turns
// "the logged-in user + an org" into the two env vars the engine reads (BOARDWALK_API_KEY +
// BOARDWALK_INFERENCE_URL), minting + caching that key on demand.
//
// Best-effort by design: it NEVER throws. A logged-out author can still `dev` an agent-free
// workflow; only a program that actually calls the default provider hits the engine's (actionable)
// "no inference set up" error.

import { BoardwalkClient } from "../client.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken } from "../auth/resolve.js";
import type { FetchLike } from "../auth/pkce.js";

/** Re-mint when a cached key is within this of expiry, so a run can't start with a key that dies
 *  mid-run. */
const EXPIRY_SKEW_MS = 24 * 60 * 60 * 1000; // 1 day
/** Fallback cache TTL when the server doesn't report an expiry (it does today). */
const FALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface ResolveInferenceEnvDeps {
  config: CliConfig;
  /** The org to bill managed inference to (from `--org` or the project link). Null = unresolved. */
  orgSlug: string | null;
  /** The effective pre-overlay env (process env merged with the run's .env) — so a user-set
   *  BOARDWALK_API_KEY is honored and we mint nothing. */
  env: NodeJS.ProcessEnv;
  /** A one-off bearer (`--token`) to mint with, instead of the stored session. */
  tokenFlag?: string | undefined;
  store?: CredentialStore;
  fetchImpl?: FetchLike;
  now?: number;
  /** Diagnostics sink — defaults to console.error so hints never pollute the stdout event stream. */
  log?: (line: string) => void;
}

/**
 * Resolve the env overlay that lets `boardwalk dev`'s engine reach Boardwalk managed inference for
 * `agent()` calls naming no provider: `{ BOARDWALK_API_KEY, BOARDWALK_INFERENCE_URL }`.
 *
 * Returns an EMPTY overlay (and the engine then errors actionably only if the program really calls
 * the default provider) when: the user already set BOARDWALK_API_KEY; no org was resolvable; or the
 * mint failed / no session (a hint is logged to stderr). Never throws.
 */
export async function resolveInferenceEnv(
  deps: ResolveInferenceEnvDeps,
): Promise<Record<string, string>> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.error(line);
    });
  const now = deps.now ?? Date.now();

  // 1. The user already provided a key (shell env or .env) — respect it, mint nothing.
  if (nonEmpty(deps.env.BOARDWALK_API_KEY)) return {};
  // 2. Managed inference bills an org; without one we can't mint.
  if (deps.orgSlug === null) return {};

  const store = deps.store ?? CredentialStore.atConfigDir(deps.config.configDir);
  const inferenceUrl = `${deps.config.apiBaseUrl}/v1/inference`;
  const cacheKey = `${deps.config.apiBaseUrl}|${deps.orgSlug}`;

  // 3. Reuse a cached key that won't expire mid-run.
  const cached = store.getInferenceKey(cacheKey);
  if (cached !== null && cached.expiresAt - EXPIRY_SKEW_MS > now) {
    return { BOARDWALK_API_KEY: cached.token, BOARDWALK_INFERENCE_URL: inferenceUrl };
  }

  // 4. Need to mint, but only if a credential is even available. With no session and no --token,
  //    stay SILENT — an agent-free workflow runs fine, and an agent() one gets the engine's own
  //    actionable "no inference set up" error. (We'd only nag every agent-free run otherwise.)
  if (deps.tokenFlag === undefined && store.getSession() === null) return {};

  // 5. Mint a fresh key with the login session (or --token), and cache it.
  try {
    const token = await resolveToken({
      config: deps.config,
      store,
      ...(deps.tokenFlag !== undefined ? { tokenFlag: deps.tokenFlag } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const client = new BoardwalkClient({
      baseUrl: deps.config.apiBaseUrl,
      token,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
    const minted = await client.mintInferenceKey(deps.orgSlug);
    store.putInferenceKey(cacheKey, {
      token: minted.token,
      expiresAt: minted.expiresAt ?? now + FALLBACK_TTL_MS,
      id: minted.id,
    });
    return { BOARDWALK_API_KEY: minted.token, BOARDWALK_INFERENCE_URL: inferenceUrl };
  } catch (err) {
    log(
      `note: agent() defaults to Boardwalk managed inference, but I couldn't get an inference ` +
        `key for org "${deps.orgSlug}" (${err instanceof Error ? err.message : "unknown error"}). ` +
        "Run `boardwalk login`, set BOARDWALK_API_KEY, or name a provider explicitly.",
    );
    return {};
  }
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
