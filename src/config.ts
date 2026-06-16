// SPDX-License-Identifier: MIT

// CLI configuration — resolved from environment variables with sane defaults.
//
// Endpoints are NOT hardcoded into logic; they derive from env so the same binary targets prod
// (the default), a dev stack, or a customer's SELF-HOSTED deployment on their own domain. The
// identity provider behind `login` is an internal detail — the CLI only ever knows an "issuer URL",
// never the vendor.

import envPaths from "env-paths";

export interface CliConfig {
  /** REST API base, e.g. https://api.boardwalk.sh (no trailing slash). */
  apiBaseUrl: string;
  /**
   * Whether `apiBaseUrl` came from an EXPLICIT env override (`BOARDWALK_API_URL` /
   * `BOARDWALK_API_DOMAIN`) rather than the prod default. When false, an authenticated command
   * prefers the stored session's own API origin over the default — so logging into a dev/self-host
   * stack just works without re-exporting the env on every call. Optional for back-compat with
   * callers (and tests) that build a config by hand; absent ⇒ treated as not-explicit.
   */
  apiBaseExplicit?: boolean;
  /** OAuth issuer origin `boardwalk login` authenticates against (provider-agnostic). */
  issuerUrl: string;
  /** Public OAuth client id for the CLI's OAuth application. Null until configured. */
  oauthClientId: string | null;
  /** Fixed loopback port for the PKCE redirect (must be allowlisted on the OAuth application). */
  loopbackPort: number;
  /** Directory holding the credentials file (XDG config dir by default). */
  configDir: string;
}

/** Default API host. Self-hosters override with `BOARDWALK_API_DOMAIN=api.their-company.com`. */
const DEFAULT_API_DOMAIN = "api.boardwalk.sh";
/**
 * Default OAuth issuer for `login`. Boardwalk self-hosts its OAuth server, so the issuer is the API
 * host itself — the CLI fetches `<issuer>/.well-known/oauth-authorization-server` to discover the
 * authorize page (web app) + token endpoint (api). Override with `BOARDWALK_ISSUER_URL` for dev.
 */
const DEFAULT_ISSUER_URL = `https://${DEFAULT_API_DOMAIN}`;
/** The first-party CLI's public OAuth client id (registered in the backend's in-code client registry).
 *  Shipped as a default so users don't configure it; override with `BOARDWALK_OAUTH_CLIENT_ID`. */
const DEFAULT_OAUTH_CLIENT_ID = "boardwalk-cli";
/** A fixed, memorable loopback port (cf. aws/gcloud). Must match the OAuth redirect allowlist. */
const DEFAULT_LOOPBACK_PORT = 53682;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const paths = envPaths("boardwalk", { suffix: "" });
  const explicit = explicitApiBaseUrl(env);
  return {
    apiBaseUrl: explicit ?? `https://${DEFAULT_API_DOMAIN}`,
    apiBaseExplicit: explicit !== null,
    issuerUrl: trimTrailingSlash(env.BOARDWALK_ISSUER_URL ?? DEFAULT_ISSUER_URL),
    oauthClientId: nonEmpty(env.BOARDWALK_OAUTH_CLIENT_ID) ?? DEFAULT_OAUTH_CLIENT_ID,
    loopbackPort: parsePort(env.BOARDWALK_OAUTH_PORT) ?? DEFAULT_LOOPBACK_PORT,
    configDir: nonEmpty(env.BOARDWALK_CONFIG_DIR) ?? paths.config,
  };
}

/**
 * The API base set EXPLICITLY via env, or null when neither knob is set:
 *   1. `BOARDWALK_API_URL`    — a full URL (escape hatch for local http / non-standard ports)
 *   2. `BOARDWALK_API_DOMAIN` — a hostname → `https://<domain>` (the self-host knob)
 * Distinct from {@link loadConfig}'s `apiBaseUrl` (which falls back to the prod default): a null here
 * means "no override — a stored session's origin may be preferred."
 */
export function explicitApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const fullUrl = nonEmpty(env.BOARDWALK_API_URL);
  if (fullUrl !== null) return trimTrailingSlash(fullUrl);
  const domain = nonEmpty(env.BOARDWALK_API_DOMAIN);
  return domain !== null ? `https://${normalizeDomain(domain)}` : null;
}

/** Strip any scheme + trailing slashes from a domain so `https://<domain>` is well-formed. */
function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse a 1–65535 port from a string, or null when unset/invalid (caller falls back to default). */
function parsePort(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value.trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}
