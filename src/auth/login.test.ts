// SPDX-License-Identifier: MIT

// Unit tests for `performLogin` — the browser PKCE orchestration in login.ts. Unlike
// auth_flow_e2e.test.ts (which spins up real loopback + issuer servers), these tests mock the
// `discovery` and `pkce` modules so each branch of the orchestration can be driven deterministically
// (no network, no real HTTP server, no real clock): the happy path, discovery/exchange failures, a
// denied / state-mismatch callback, an aborted/timed-out callback, missing client-id config, and the
// interactive-vs-token branch selection.

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { CredentialStore, StoredSession } from "../credentials.js";

// ---- Module mocks -----------------------------------------------------------------------------
// performLogin imports discoverOAuth from ./discovery and the PKCE primitives from ./pkce. We mock
// both so we can assert how performLogin wires them together and inject failures at each seam.

vi.mock("./discovery.js", () => ({
  discoverOAuth: vi.fn(),
}));

vi.mock("./pkce.js", () => ({
  generatePkcePair: vi.fn(() => ({ verifier: "test-verifier", challenge: "test-challenge" })),
  randomState: vi.fn(() => "test-state"),
  buildAuthorizeUrl: vi.fn(() => "https://auth.example/oauth/authorize?state=test-state"),
  exchangeCode: vi.fn(),
  startLoopback: vi.fn(),
}));

import { performLogin } from "./login.js";
import { discoverOAuth } from "./discovery.js";
import {
  generatePkcePair,
  randomState,
  buildAuthorizeUrl,
  exchangeCode,
  startLoopback,
} from "./pkce.js";

const discoverOAuthMock = discoverOAuth as unknown as Mock;
const generatePkcePairMock = generatePkcePair as unknown as Mock;
const randomStateMock = randomState as unknown as Mock;
const buildAuthorizeUrlMock = buildAuthorizeUrl as unknown as Mock;
const exchangeCodeMock = exchangeCode as unknown as Mock;
const startLoopbackMock = startLoopback as unknown as Mock;

// ---- Test doubles -----------------------------------------------------------------------------

/** A no-op logger so the orchestration under test does not write to the test console. */
function silent(): void {
  /* intentionally empty */
}

function makeConfig(over: Partial<CliConfig> = {}): CliConfig {
  return {
    apiBaseUrl: "https://api.example",
    issuerUrl: "https://auth.example",
    oauthClientId: "client_test",
    loopbackPort: 53682,
    configDir: "/unused",
    ...over,
  };
}

interface FakeStore {
  store: CredentialStore;
  putSession: Mock;
  saved: { value: StoredSession | null };
}

function makeStore(): FakeStore {
  const saved: { value: StoredSession | null } = { value: null };
  const putSession = vi.fn((session: StoredSession) => {
    saved.value = session;
  });
  // Only `putSession` is exercised by performLogin; cast the partial to the interface.
  const store = { putSession } as unknown as CredentialStore;
  return { store, putSession, saved };
}

interface FakeLoopback {
  loopback: {
    redirectUri: string;
    port: number;
    awaitCode: Mock;
    close: Mock;
  };
  close: Mock;
  awaitCode: Mock;
}

/**
 * A fake loopback whose `awaitCode` resolves/rejects per the provided behavior. Tracks `close` so
 * tests can assert cleanup happens even on the error paths (the `finally` in performLogin).
 */
function makeLoopback(awaitCodeImpl: () => Promise<string>): FakeLoopback {
  const awaitCode = vi.fn(awaitCodeImpl);
  const close = vi.fn();
  const loopback = {
    redirectUri: "http://127.0.0.1:53682/callback",
    port: 53682,
    awaitCode,
    close,
  };
  return { loopback, close, awaitCode };
}

const goodDiscovery = {
  authorizationEndpoint: "https://app.example/oauth/authorize",
  tokenEndpoint: "https://api.example/oauth/token",
};

const goodToken = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  expiresAt: 1_700_000_000_000,
  scope: "openid profile email offline_access",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible happy-path defaults; individual tests override as needed.
  generatePkcePairMock.mockReturnValue({ verifier: "test-verifier", challenge: "test-challenge" });
  randomStateMock.mockReturnValue("test-state");
  buildAuthorizeUrlMock.mockReturnValue(
    "https://app.example/oauth/authorize?client_id=client_test&state=test-state",
  );
  discoverOAuthMock.mockResolvedValue(goodDiscovery);
  exchangeCodeMock.mockResolvedValue(goodToken);
});

describe("performLogin — successful interactive flow", () => {
  it("stores credentials and returns the session with the exchanged token", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback, close } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);
    const openBrowser = vi.fn(() => Promise.resolve());

    const session = await performLogin({ config, store, openBrowser, log: silent });

    // Returned session carries everything from the token exchange + discovery + config.
    expect(session).toEqual<StoredSession>({
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      expiresAt: 1_700_000_000_000,
      clientId: "client_test",
      tokenEndpoint: "https://api.example/oauth/token",
      scope: "openid profile email offline_access",
    });

    // It persisted exactly that session.
    expect(putSession).toHaveBeenCalledTimes(1);
    expect(putSession).toHaveBeenCalledWith(session);

    // It opened the browser at the built authorize URL and the loopback was cleaned up.
    expect(openBrowser).toHaveBeenCalledWith(
      "https://app.example/oauth/authorize?client_id=client_test&state=test-state",
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for the callback using the generated CSRF state and exchanges the returned code", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    const { loopback, awaitCode } = makeLoopback(() => Promise.resolve("auth-code-xyz"));
    startLoopbackMock.mockResolvedValue(loopback);

    await performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent });

    // The state passed to awaitCode is the one generated up-front (CSRF binding).
    expect(awaitCode).toHaveBeenCalledWith("test-state");

    // The exchange used the PKCE verifier, the loopback redirect URI, the configured client id and
    // the code from the callback.
    expect(exchangeCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenEndpoint: "https://api.example/oauth/token",
        clientId: "client_test",
        code: "auth-code-xyz",
        codeVerifier: "test-verifier",
        redirectUri: "http://127.0.0.1:53682/callback",
      }),
    );
  });

  it("passes a custom scope through to the authorize URL when provided", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    const { loopback } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);

    await performLogin({
      config,
      store,
      openBrowser: () => Promise.resolve(),
      log: silent,
      scope: "openid custom",
    });

    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "openid custom" }),
    );
  });

  it("defaults the scope to openid+profile+email+offline_access", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    const { loopback } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);

    await performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent });

    expect(buildAuthorizeUrlMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "openid profile email offline_access" }),
    );
  });
});

describe("performLogin — discovery / token-exchange failure (login.ts:44-49 seam)", () => {
  it("surfaces a discovery CliError rather than a raw exception and never opens the browser", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const discoveryError = new CliError(
      "Could not reach the OAuth discovery endpoint (https://auth.example/.well-known/oauth-authorization-server).",
      "network down",
    );
    discoverOAuthMock.mockRejectedValue(discoveryError);
    const openBrowser = vi.fn(() => Promise.resolve());

    await expect(performLogin({ config, store, openBrowser, log: silent })).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(performLogin({ config, store, openBrowser, log: silent })).rejects.toThrow(
      /Could not reach the OAuth discovery endpoint/,
    );

    // We failed before starting the loopback / opening the browser / persisting anything.
    expect(startLoopbackMock).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(putSession).not.toHaveBeenCalled();
  });

  it("surfaces a token-exchange CliError and still closes the loopback (cleanup)", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback, close } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);
    exchangeCodeMock.mockRejectedValue(
      new CliError("Token request failed (400).", "invalid_grant"),
    );

    await expect(
      performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent }),
    ).rejects.toThrow(/Token request failed \(400\)/);

    // Mapped CliError, not a raw fetch exception; session not stored; loopback cleaned up.
    expect(putSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("performLogin — denied / state-mismatch authorization (pkce.ts:56-58 seam)", () => {
  it("reports a state-mismatch (CSRF) callback as a CliError and closes the loopback", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback, close } = makeLoopback(() =>
      Promise.reject(new CliError("Authorization failed: state mismatch (possible CSRF).")),
    );
    startLoopbackMock.mockResolvedValue(loopback);

    await expect(
      performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent }),
    ).rejects.toThrow(/state mismatch \(possible CSRF\)/);

    // No exchange attempted, nothing stored, loopback torn down.
    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(putSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports a denied authorization (error in callback) as a CliError", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback, close } = makeLoopback(() =>
      Promise.reject(new CliError("Authorization failed: access_denied")),
    );
    startLoopbackMock.mockResolvedValue(loopback);

    await expect(
      performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent }),
    ).rejects.toThrow(/Authorization failed: access_denied/);

    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(putSession).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("performLogin — timeout / aborted callback (pkce.ts:103-106 seam)", () => {
  it("propagates the callback timeout error and cleans up the loopback", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback, close } = makeLoopback(() =>
      Promise.reject(new CliError("Timed out waiting for the browser authorization (3 min).")),
    );
    startLoopbackMock.mockResolvedValue(loopback);

    await expect(
      performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent }),
    ).rejects.toThrow(/Timed out waiting for the browser authorization/);

    // The finally block must have closed the loopback even though no code ever arrived.
    expect(close).toHaveBeenCalledTimes(1);
    expect(exchangeCodeMock).not.toHaveBeenCalled();
    expect(putSession).not.toHaveBeenCalled();
  });
});

describe("performLogin — invalid configuration / unreachable issuer", () => {
  it("throws a friendly CliError (with a hint) and does no work when no client id is configured", async () => {
    const config = makeConfig({ oauthClientId: null });
    const { store, putSession } = makeStore();
    const openBrowser = vi.fn(() => Promise.resolve());

    let caught: unknown;
    try {
      await performLogin({ config, store, openBrowser, log: silent });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    const cliError = caught as CliError;
    expect(cliError.message).toMatch(/No OAuth client id configured/);
    // Friendly, actionable hint pointing at the env var + redirect allowlist.
    expect(cliError.hint).toMatch(/BOARDWALK_OAUTH_CLIENT_ID/);
    expect(cliError.hint).toMatch(/127\.0\.0\.1:53682\/callback/);

    // Nothing downstream ran.
    expect(discoverOAuthMock).not.toHaveBeenCalled();
    expect(startLoopbackMock).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
    expect(putSession).not.toHaveBeenCalled();
  });

  it("surfaces an unreachable-issuer discovery failure as a friendly CliError", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    discoverOAuthMock.mockRejectedValue(
      new CliError(
        "Could not reach the OAuth discovery endpoint (https://auth.example/.well-known/oauth-authorization-server).",
        "Check BOARDWALK_ISSUER_URL (or BOARDWALK_API_DOMAIN) points at a Boardwalk deployment.",
      ),
    );

    let caught: unknown;
    try {
      await performLogin({ config, store, openBrowser: () => Promise.resolve(), log: silent });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).hint).toMatch(/BOARDWALK_ISSUER_URL/);
  });
});

describe("performLogin — branch selection (interactive vs. browser open default)", () => {
  it("uses the injected openBrowser (interactive path) instead of the real `open` package", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    const { loopback } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);
    const openBrowser = vi.fn(() => Promise.resolve());

    await performLogin({ config, store, openBrowser, log: silent });

    expect(openBrowser).toHaveBeenCalledTimes(1);
  });

  it("treats a browser-open failure as non-fatal and still completes via the callback", async () => {
    const config = makeConfig();
    const { store, putSession } = makeStore();
    const { loopback } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);
    // The user can paste the printed URL — a failed `open` must not abort login.
    const openBrowser = vi.fn(() => Promise.reject(new Error("no display available")));

    const session = await performLogin({ config, store, openBrowser, log: silent });

    expect(session.accessToken).toBe("access-token-1");
    expect(putSession).toHaveBeenCalledTimes(1);
  });

  it("emits the 'open your browser' guidance including the authorize URL", async () => {
    const config = makeConfig();
    const { store } = makeStore();
    const { loopback } = makeLoopback(() => Promise.resolve("auth-code-1"));
    startLoopbackMock.mockResolvedValue(loopback);
    const lines: string[] = [];

    await performLogin({
      config,
      store,
      openBrowser: () => Promise.resolve(),
      log: (line) => lines.push(line),
    });

    expect(lines.some((l) => l.includes("Opening your browser"))).toBe(true);
    expect(lines.some((l) => l.includes("/oauth/authorize"))).toBe(true);
  });
});
