// `boardwalk login` / `logout` / `whoami` — session lifecycle.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { performLogin } from "../auth/login.js";

export interface SessionDeps {
  config: CliConfig;
  log?: (line: string) => void;
}

export interface LoginOptions {
  /** Persist this API key (`bwk_…`) instead of running the browser PKCE flow. */
  token?: string | undefined;
}

export async function runLogin(deps: SessionDeps, opts: LoginOptions = {}): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
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

  const session = await performLogin({ config: deps.config, store, log });
  const expiry =
    session.expiresAt !== null ? ` (expires ${new Date(session.expiresAt).toISOString()})` : "";
  log(`✓ Logged in.${expiry}`);
}

export function runLogout(deps: SessionDeps): void {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  store.clear();
  log("✓ Logged out — local credentials removed.");
}

/** Report whether a stored session exists. (Identity claims live in the JWT; v0 keeps this minimal.) */
export function runWhoami(deps: SessionDeps): void {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
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
