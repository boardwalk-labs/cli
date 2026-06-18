// SPDX-License-Identifier: MIT

// performLogin — orchestrates the browser PKCE handshake and persists the session.
//
// Flow: start the loopback callback server → open the issuer's /oauth/authorize in the browser →
// catch the redirect (validating state) → exchange the code at /oauth/token → store the session.
// Requires a configured OAuth application (public client id) whose redirect allowlist includes the
// loopback URI.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { CredentialStore, StoredSession } from "../credentials.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkcePair,
  randomState,
  startLoopback,
  type FetchLike,
} from "./pkce.js";
import { discoverOAuth } from "./discovery.js";
import { resolveLog } from "../log.js";

/**
 * openid+profile+email so the issued JWT carries the claims the backend JIT-provisions users from;
 * `offline_access` so the IdP returns a refresh token (OIDC providers only mint one when it's
 * requested) — without it every expired session would force a full re-login instead of a silent
 * `resolveToken` refresh.
 */
const DEFAULT_SCOPE = "openid profile email offline_access";

export interface PerformLoginDeps {
  config: CliConfig;
  store: CredentialStore;
  /** Opens a URL in the user's browser. Injected for tests; defaults to the `open` package. */
  openBrowser?: (url: string) => Promise<void>;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  scope?: string;
  /** OAuth client id to authenticate as, overriding `config.oauthClientId` — used by the elevated
   *  login (`--scopes admin`) to authenticate against the admin client and obtain its write scopes. */
  clientIdOverride?: string;
}

export async function performLogin(deps: PerformLoginDeps): Promise<StoredSession> {
  const clientId = deps.clientIdOverride ?? deps.config.oauthClientId;
  if (clientId === null) {
    throw new CliError(
      "No OAuth client id configured for `boardwalk login`.",
      "Set BOARDWALK_OAUTH_CLIENT_ID to the OAuth application's public client id " +
        `(its redirect allowlist must include http://127.0.0.1:${String(deps.config.loopbackPort)}/callback).`,
    );
  }

  const endpoints = await discoverOAuth(deps.config.issuerUrl, deps.fetchImpl);
  const { verifier, challenge } = generatePkcePair();
  const state = randomState();
  const log = resolveLog(deps);

  const loopback = await startLoopback(deps.config.loopbackPort);
  try {
    const url = buildAuthorizeUrl({
      authorizeEndpoint: endpoints.authorizationEndpoint,
      clientId,
      redirectUri: loopback.redirectUri,
      codeChallenge: challenge,
      state,
      scope: deps.scope ?? DEFAULT_SCOPE,
    });

    log("Opening your browser to sign in to Boardwalk…");
    log(`If it doesn't open automatically, visit:\n  ${url}`);
    const openBrowser = deps.openBrowser ?? defaultOpenBrowser;
    await openBrowser(url).catch(() => {
      // Non-fatal: the user can paste the URL printed above.
    });

    const code = await loopback.awaitCode(state);
    const token = await exchangeCode({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId,
      code,
      codeVerifier: verifier,
      redirectUri: loopback.redirectUri,
      fetchImpl: deps.fetchImpl,
    });

    const session: StoredSession = {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      clientId,
      tokenEndpoint: endpoints.tokenEndpoint,
      scope: token.scope,
    };
    deps.store.putSession(session);
    return session;
  } finally {
    loopback.close();
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const open = (await import("open")).default;
  await open(url);
}
