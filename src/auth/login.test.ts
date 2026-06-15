// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { request, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performLogin } from "./login.js";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { CredentialStore, StoredSession } from "../credentials.js";
import type { FetchLike } from "./pkce.js";

// performLogin is an end-to-end orchestration: it discovers the OAuth endpoints, starts a real
// loopback HTTP server, "opens the browser", catches the redirect (validating state), exchanges the
// code at the token endpoint, and persists the session. We drive it deterministically by injecting:
//   - fetchImpl: a stub that answers discovery + token requests (and can fail / return non-OK).
//   - openBrowser: a stub that, instead of opening a browser, performs the loopback callback GET —
//     which is exactly what a real IdP redirect would do. The query params it sends let us simulate
//     the success path, a state/CSRF mismatch, etc.
//
// Notes:
//   - We use a REAL ephemeral loopback port (the server + callback are real sockets), so we cannot
//     use fake timers (they would stall the HTTP transport). For expiry we capture Date.now()
//     around the call and assert the absolute expiry lands in the expected window.

const AUTHORIZE_ENDPOINT = "https://issuer.example/oauth/authorize";
const TOKEN_ENDPOINT = "https://issuer.example/oauth/token";
const DISCOVERY_DOC = {
  authorization_endpoint: AUTHORIZE_ENDPOINT,
  token_endpoint: TOKEN_ENDPOINT,
};

/** Swallow log lines so tests don't write to the console. */
function noop(): void {
  /* intentionally empty */
}

/** Reserve a free localhost port by opening (then closing) a throwaway server. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

function makeConfig(port: number, overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    issuerUrl: "https://issuer.example",
    oauthClientId: "public-client-id",
    loopbackPort: port,
    ...overrides,
  } as CliConfig;
}

interface RecordingStore {
  store: CredentialStore;
  putSession: ReturnType<typeof vi.fn>;
  saved: StoredSession[];
}

function makeStore(): RecordingStore {
  const saved: StoredSession[] = [];
  const putSession = vi.fn((session: StoredSession) => {
    saved.push(session);
  });
  const store = { putSession } as unknown as CredentialStore;
  return { store, putSession, saved };
}

/** Perform the loopback callback GET the way a real browser redirect from the IdP would. */
function hitCallback(url: string, query: Record<string, string>): Promise<void> {
  // The authorize URL carries the loopback redirect_uri + state we must echo back.
  const authorizeUrl = new URL(url);
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  if (redirectUri === null) throw new Error("authorize url missing redirect_uri");
  const callback = new URL(redirectUri);
  for (const [k, v] of Object.entries(query)) callback.searchParams.set(k, v);

  return new Promise<void>((resolve, reject) => {
    const req = request(callback, (res) => {
      res.on("data", noop);
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A browser opener that drives the callback. `state: "echo"` reflects the real state back. */
function callbackOpener(query: Record<string, string>): (url: string) => Promise<void> {
  return (url: string) => {
    const authorizeUrl = new URL(url);
    const realState = authorizeUrl.searchParams.get("state") ?? "";
    const resolved = { ...query };
    if (resolved.state === "echo") resolved.state = realState;
    // Fire the callback but don't await it inside openBrowser — performLogin awaits the loopback
    // separately. Returning immediately mirrors `open()` resolving before the redirect lands.
    void hitCallback(url, resolved);
    return Promise.resolve();
  };
}

interface FetchStubOptions {
  tokenStatus?: number;
  tokenBody?: unknown;
  tokenThrows?: Error;
}

/** Turn any fetch input (string | URL | Request) into the request URL string. */
function targetUrl(input: Parameters<FetchLike>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function makeFetch(opts: FetchStubOptions): FetchLike {
  return vi.fn(async (input: Parameters<FetchLike>[0]) => {
    const target = targetUrl(input);
    if (target.includes("/.well-known") || target.includes("oauth-authorization-server")) {
      return new Response(JSON.stringify(DISCOVERY_DOC), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target === TOKEN_ENDPOINT) {
      if (opts.tokenThrows) throw opts.tokenThrows;
      const status = opts.tokenStatus ?? 200;
      const body =
        typeof opts.tokenBody === "string" ? opts.tokenBody : JSON.stringify(opts.tokenBody);
      return new Response(body, { status });
    }
    throw new Error(`unexpected fetch to ${target}`);
  });
}

describe("performLogin", () => {
  let port: number;

  beforeEach(async () => {
    port = await freePort();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects with an actionable CliError when no OAuth client id is configured", async () => {
    const { store, putSession } = makeStore();
    await expect(
      performLogin({
        config: makeConfig(port, { oauthClientId: null }),
        store,
        fetchImpl: makeFetch({}),
        openBrowser: callbackOpener({ code: "x", state: "echo" }),
        log: noop,
      }),
    ).rejects.toBeInstanceOf(CliError);
    expect(putSession).not.toHaveBeenCalled();
  });

  it("exchanges the code and persists the session on the happy path", async () => {
    const { store, putSession, saved } = makeStore();
    const fetchImpl = makeFetch({
      tokenBody: {
        access_token: "access-123",
        refresh_token: "refresh-456",
        expires_in: 3600,
        scope: "openid profile email offline_access",
      },
    });

    const before = Date.now();
    const session = await performLogin({
      config: makeConfig(port),
      store,
      fetchImpl,
      openBrowser: callbackOpener({ code: "auth-code-abc", state: "echo" }),
      log: noop,
    });
    const after = Date.now();

    expect(session.accessToken).toBe("access-123");
    expect(session.refreshToken).toBe("refresh-456");
    expect(session.clientId).toBe("public-client-id");
    expect(session.tokenEndpoint).toBe(TOKEN_ENDPOINT);
    expect(session.scope).toBe("openid profile email offline_access");
    // expires_in (3600s) translated into an absolute epoch-ms expiry relative to "now".
    expect(session.expiresAt).not.toBeNull();
    const expiresAt = session.expiresAt!;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 3600 * 1000);
    // The returned session is exactly what was persisted.
    expect(putSession).toHaveBeenCalledTimes(1);
    expect(saved[0]).toEqual(session);

    // The token request was a code-for-token exchange carrying the code we redirected with.
    const tokenCall = vi
      .mocked(fetchImpl)
      .mock.calls.find((c) => targetUrl(c[0]) === TOKEN_ENDPOINT);
    expect(tokenCall).toBeDefined();
    const body = (tokenCall?.[1] as { body: string }).body;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code-abc");
  });

  it("computes a null expiry when expires_in is missing", async () => {
    const { store, saved } = makeStore();
    const session = await performLogin({
      config: makeConfig(port),
      store,
      fetchImpl: makeFetch({
        tokenBody: { access_token: "no-expiry-token" },
      }),
      openBrowser: callbackOpener({ code: "c", state: "echo" }),
      log: noop,
    });
    expect(session.expiresAt).toBeNull();
    expect(session.refreshToken).toBeNull();
    expect(session.scope).toBeNull();
    expect(saved[0]?.expiresAt).toBeNull();
  });

  it("treats a zero expires_in as an immediate (now) expiry, not as missing", async () => {
    const { store } = makeStore();
    const before = Date.now();
    const session = await performLogin({
      config: makeConfig(port),
      store,
      fetchImpl: makeFetch({
        tokenBody: { access_token: "zero-expiry", expires_in: 0 },
      }),
      openBrowser: callbackOpener({ code: "c", state: "echo" }),
      log: noop,
    });
    const after = Date.now();
    // expires_in === 0 is a number, so it maps to now + 0 (NOT null).
    expect(session.expiresAt).not.toBeNull();
    const expiresAt = session.expiresAt!;
    expect(expiresAt).toBeGreaterThanOrEqual(before);
    expect(expiresAt).toBeLessThanOrEqual(after);
  });

  it("surfaces a meaningful error and persists nothing when the token endpoint returns non-OK", async () => {
    const { store, putSession } = makeStore();
    const promise = performLogin({
      config: makeConfig(port),
      store,
      fetchImpl: makeFetch({
        tokenStatus: 400,
        tokenBody: { error: "invalid_grant", error_description: "code already used" },
      }),
      openBrowser: callbackOpener({ code: "stale-code", state: "echo" }),
      log: noop,
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/Token request failed \(400\)/);
    // No partial session was written on the error path.
    expect(putSession).not.toHaveBeenCalled();
  });

  it("rejects on a state/CSRF mismatch and never reaches the token exchange", async () => {
    const { store, putSession } = makeStore();
    const fetchImpl = makeFetch({
      tokenBody: { access_token: "should-not-be-used" },
    });

    const promise = performLogin({
      config: makeConfig(port),
      store,
      fetchImpl,
      // A literal (wrong) state that won't match the random state performLogin generated.
      openBrowser: callbackOpener({ code: "c", state: "totally-wrong-state" }),
      log: noop,
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/state mismatch/i);
    expect(putSession).not.toHaveBeenCalled();
    // Discovery happens, but the token endpoint must never be called.
    const tokenCalls = vi
      .mocked(fetchImpl)
      .mock.calls.filter((c) => targetUrl(c[0]) === TOKEN_ENDPOINT);
    expect(tokenCalls).toHaveLength(0);
  });

  it("propagates a network/transport failure from the token exchange without swallowing it", async () => {
    const { store, putSession } = makeStore();
    const promise = performLogin({
      config: makeConfig(port),
      store,
      fetchImpl: makeFetch({
        tokenThrows: new TypeError("fetch failed: ECONNREFUSED"),
      }),
      openBrowser: callbackOpener({ code: "c", state: "echo" }),
      log: noop,
    });

    // The transport error is wrapped in a CliError (with the underlying message as the hint),
    // not silently swallowed.
    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow(/Could not reach the token endpoint/);
    expect(putSession).not.toHaveBeenCalled();
  });
});
