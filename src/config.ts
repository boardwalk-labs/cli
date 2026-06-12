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
  return {
    apiBaseUrl: resolveApiBaseUrl(env),
    issuerUrl: trimTrailingSlash(env.BOARDWALK_ISSUER_URL ?? DEFAULT_ISSUER_URL),
    oauthClientId: nonEmpty(env.BOARDWALK_OAUTH_CLIENT_ID) ?? DEFAULT_OAUTH_CLIENT_ID,
    loopbackPort: parsePort(env.BOARDWALK_OAUTH_PORT) ?? DEFAULT_LOOPBACK_PORT,
    configDir: nonEmpty(env.BOARDWALK_CONFIG_DIR) ?? paths.config,
  };
}

/**
 * API base URL, in precedence order:
 *   1. `BOARDWALK_API_URL`    — a full URL (escape hatch for local http / non-standard ports)
 *   2. `BOARDWALK_API_DOMAIN` — a hostname → `https://<domain>` (the self-host knob)
 *   3. the default prod domain
 */
function resolveApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const fullUrl = nonEmpty(env.BOARDWALK_API_URL);
  if (fullUrl !== null) return trimTrailingSlash(fullUrl);
  const domain = nonEmpty(env.BOARDWALK_API_DOMAIN) ?? DEFAULT_API_DOMAIN;
  return `https://${normalizeDomain(domain)}`;
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
