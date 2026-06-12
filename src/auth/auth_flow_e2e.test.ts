// End-to-end auth integration test — exercises BOTH credential methods through the REAL CLI code,
// not stubs of it:
//
//   PKCE     `performLogin` → real loopback HTTP server → real /oauth/token exchange against a local
//            mock issuer → real `CredentialStore` persistence → real `resolveToken` (incl. the
//            expired-session refresh branch) → real `BoardwalkClient` request carrying the Bearer.
//   API key  a stored / env / --token key → real `resolveToken` → real `BoardwalkClient` request.
//
// The only things substituted are the issuer's hosted authorize page (the part the CLI does not own —
// here the injected `openBrowser` plays the browser by hitting the loopback callback) and the API
// itself (a local mock that captures the inbound `Authorization` header). Everything the CLI owns —
// the loopback server, code exchange, refresh, credential file, token resolution, HTTP client — is
// the production code path. Complements pkce.test.ts (pure pieces) and resolve.test.ts (resolution
// logic with an injected fetch), which deliberately do NOT spin up the loopback server.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as netCreateServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, type StoredSession } from "../credentials.js";
import type { CliConfig } from "../config.js";
import { performLogin } from "./login.js";
import { resolveToken } from "./resolve.js";
import { runLogin } from "../commands/session.js";
import { BoardwalkClient } from "../client.js";

/** Bind a throwaway socket to :0 to learn a free port, then release it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = netCreateServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not acquire a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => {
        resolve(port);
      });
    });
  });
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/** A no-op logger so the commands under test don't write to the test console. */
function silent(): void {
  /* intentionally empty */
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
  });
}

/** A local OIDC token endpoint. Captures the last form so the test can assert what the CLI sent. */
interface MockIssuer {
  url: string;
  state: { lastForm: URLSearchParams | null };
  server: Server;
}

async function startMockIssuer(): Promise<MockIssuer> {
  const state: MockIssuer["state"] = { lastForm: null };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // RFC 8414 discovery — the CLI reads authorization_endpoint + token_endpoint from here. Both
    // live on this mock's own origin (in prod they split across the web app + api host).
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
      const base = `http://${req.headers.host ?? ""}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
        }),
      );
      return;
    }
    if (req.method === "POST" && req.url === "/oauth/token") {
      void readBody(req).then((body) => {
        const form = new URLSearchParams(body);
        state.lastForm = form;
        const grant = form.get("grant_type");
        const tokens =
          grant === "authorization_code"
            ? { access_token: "pkce-access-1", refresh_token: "pkce-refresh-1" }
            : grant === "refresh_token"
              ? { access_token: "pkce-access-2", refresh_token: "pkce-refresh-2" }
              : null;
        if (tokens === null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unsupported_grant_type" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...tokens, expires_in: 3600, scope: "openid profile email" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const port = await freePort();
  await listen(server, port);
  return { url: `http://127.0.0.1:${port}`, state, server };
}

/** A local Boardwalk API that captures the inbound Authorization header and serves a workflow list. */
interface MockApi {
  url: string;
  state: { lastAuth: string | null; requests: number };
  server: Server;
}

async function startMockApi(): Promise<MockApi> {
  const state: MockApi["state"] = { lastAuth: null, requests: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    state.requests += 1;
    state.lastAuth = req.headers.authorization ?? null;
    if (req.method === "GET" && /^\/v1\/orgs\/[^/]+\/workflows$/.test(req.url ?? "")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ workflows: [{ id: "wf_1", name: "demo", currentVersionId: null }] }),
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }));
  });
  const port = await freePort();
  await listen(server, port);
  return { url: `http://127.0.0.1:${port}`, state, server };
}

describe("auth end-to-end (PKCE + API key)", () => {
  let issuer: MockIssuer;
  let api: MockApi;
  let dir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    issuer = await startMockIssuer();
    api = await startMockApi();
    dir = mkdtempSync(join(tmpdir(), "bw-e2e-"));
    store = CredentialStore.atConfigDir(dir);
  });

  afterEach(async () => {
    await close(issuer.server);
    await close(api.server);
    rmSync(dir, { recursive: true, force: true });
  });

  async function config(): Promise<CliConfig> {
    return {
      apiBaseUrl: api.url,
      issuerUrl: issuer.url,
      oauthClientId: "client_e2e",
      loopbackPort: await freePort(),
      configDir: dir,
    };
  }

  /** Plays the browser: pulls redirect_uri + state out of the authorize URL and hits the loopback. */
  function browserThatApproves(onUrl?: (url: string) => void): (url: string) => Promise<void> {
    return (url: string) => {
      onUrl?.(url);
      const authorize = new URL(url);
      const redirectUri = authorize.searchParams.get("redirect_uri") ?? "";
      const state = authorize.searchParams.get("state") ?? "";
      // Fire AFTER `awaitCode` sets the expected state (it runs synchronously once openBrowser
      // resolves); the loopback rejects a callback whose state it isn't yet expecting.
      setTimeout(() => {
        const cb = `${redirectUri}?code=auth-code-xyz&state=${encodeURIComponent(state)}`;
        void fetch(cb).catch(() => {
          /* the loopback already answered; a late socket error is harmless */
        });
      }, 25);
      return Promise.resolve();
    };
  }

  it("PKCE: full browser handshake → persisted session → authenticated API request", async () => {
    const cfg = await config();

    let authorizeUrl = "";
    const session = await performLogin({
      config: cfg,
      store,
      openBrowser: browserThatApproves((url) => {
        authorizeUrl = url;
      }),
      log: silent,
    });

    // The authorize request asks for `offline_access`, so the IdP returns a refresh token and the
    // session can refresh silently rather than forcing a re-login at expiry.
    expect(new URL(authorizeUrl).searchParams.get("scope")).toBe(
      "openid profile email offline_access",
    );

    // The token the issuer minted for the authorization_code exchange is what we got + stored.
    expect(session.accessToken).toBe("pkce-access-1");
    expect(session.refreshToken).toBe("pkce-refresh-1");
    expect(store.getSession()?.accessToken).toBe("pkce-access-1");
    expect(store.getSession()?.tokenEndpoint).toBe(`${issuer.url}/oauth/token`);

    // The CLI really performed a PKCE authorization_code exchange (verifier present, our client id).
    const form = issuer.state.lastForm;
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code")).toBe("auth-code-xyz");
    expect(form?.get("client_id")).toBe("client_e2e");
    expect((form?.get("code_verifier") ?? "").length).toBeGreaterThan(0);

    // Resolve the stored session and make a real authenticated request.
    const token = await resolveToken({ config: cfg, store, env: {} });
    expect(token).toBe("pkce-access-1");

    const client = new BoardwalkClient({ baseUrl: cfg.apiBaseUrl, token });
    const workflows = await client.listWorkflows("acme");
    expect(workflows).toEqual([{ id: "wf_1", name: "demo", currentVersionId: null }]);
    expect(api.state.lastAuth).toBe("Bearer pkce-access-1");
  });

  it("PKCE: an expired session is silently refreshed against the issuer, then used", async () => {
    const cfg = await config();
    store.putSession({
      accessToken: "stale-access",
      refreshToken: "pkce-refresh-1",
      expiresAt: 1_000, // already past relative to `now` below
      clientId: "client_e2e",
      tokenEndpoint: `${issuer.url}/oauth/token`,
      scope: "openid profile email",
    });

    const token = await resolveToken({ config: cfg, store, env: {}, now: 10_000 });

    // The refresh grant was used and the rotated token was both returned and persisted.
    expect(issuer.state.lastForm?.get("grant_type")).toBe("refresh_token");
    expect(issuer.state.lastForm?.get("refresh_token")).toBe("pkce-refresh-1");
    expect(token).toBe("pkce-access-2");
    expect(store.getSession()?.accessToken).toBe("pkce-access-2");
    expect(store.getSession()?.refreshToken).toBe("pkce-refresh-2");

    const client = new BoardwalkClient({ baseUrl: cfg.apiBaseUrl, token });
    await client.listWorkflows("acme");
    expect(api.state.lastAuth).toBe("Bearer pkce-access-2");
  });

  it("API key: `login --token` persists it, then it authenticates an API request", async () => {
    const cfg = await config();
    const key = "bwk_e2e_live_key";

    await runLogin({ config: cfg, log: silent }, { token: key });

    // Stored as a non-expiring, non-refreshable session (no token endpoint / refresh token).
    const stored: StoredSession | null = store.getSession();
    expect(stored?.accessToken).toBe(key);
    expect(stored?.tokenEndpoint).toBeNull();
    expect(stored?.refreshToken).toBeNull();

    const token = await resolveToken({ config: cfg, store, env: {} });
    expect(token).toBe(key);

    const client = new BoardwalkClient({ baseUrl: cfg.apiBaseUrl, token });
    await client.listWorkflows("acme");
    expect(api.state.lastAuth).toBe(`Bearer ${key}`);
  });

  it("API key: the BOARDWALK_API_KEY env path reaches the API unchanged", async () => {
    const cfg = await config();
    const key = "bwk_env_ci_key";

    const token = await resolveToken({
      config: cfg,
      store,
      env: { BOARDWALK_API_KEY: key },
    });
    expect(token).toBe(key);

    const client = new BoardwalkClient({ baseUrl: cfg.apiBaseUrl, token });
    await client.listWorkflows("acme");
    expect(api.state.lastAuth).toBe(`Bearer ${key}`);
  });

  it("the --token flag overrides a stored session and reaches the API", async () => {
    const cfg = await config();
    store.putSession({
      accessToken: "stored-session-token",
      refreshToken: null,
      expiresAt: null,
      clientId: null,
      tokenEndpoint: null,
      scope: "api-key",
    });

    const token = await resolveToken({
      config: cfg,
      store,
      tokenFlag: "bwk_one_off_flag",
      env: { BOARDWALK_API_KEY: "bwk_should_be_ignored" },
    });
    expect(token).toBe("bwk_one_off_flag");

    const client = new BoardwalkClient({ baseUrl: cfg.apiBaseUrl, token });
    await client.listWorkflows("acme");
    expect(api.state.lastAuth).toBe("Bearer bwk_one_off_flag");
  });
});
