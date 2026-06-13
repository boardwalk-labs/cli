import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInferenceEnv } from "./inference.js";
import { CredentialStore } from "../credentials.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function cfg(configDir: string): CliConfig {
  return {
    apiBaseUrl: "https://api.test",
    issuerUrl: "https://api.test",
    oauthClientId: "boardwalk-cli",
    loopbackPort: 1234,
    configDir,
  };
}

/** A fetch stub that records calls and answers the mint endpoint. */
function mintStub(answer: { status: number; body: unknown }) {
  const calls: { url: string }[] = [];
  const fetchImpl: FetchLike = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url });
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, calls };
}

const MINT_OK = {
  status: 201,
  body: { token: "bwk_minted", apiKey: { id: "01H_k", expiresAt: NOW + 30 * DAY } },
};

describe("resolveInferenceEnv", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-inf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("mints + caches a key and returns the BOARDWALK_API_KEY + gateway URL overlay", async () => {
    const store = CredentialStore.atConfigDir(dir);
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: {},
      tokenFlag: "bwk_session",
      store,
      fetchImpl,
      now: NOW,
    });
    expect(env).toEqual({
      BOARDWALK_API_KEY: "bwk_minted",
      BOARDWALK_INFERENCE_URL: "https://api.test/v1/inference",
    });
    expect(calls[0]?.url).toBe("https://api.test/v1/orgs/acme/inference-keys");
    // Cached for reuse.
    expect(store.getInferenceKey("https://api.test|acme")?.token).toBe("bwk_minted");
  });

  it("reuses a cached key without minting again", async () => {
    const store = CredentialStore.atConfigDir(dir);
    store.putInferenceKey("https://api.test|acme", {
      token: "bwk_cached",
      expiresAt: NOW + 30 * DAY,
      id: "01H_old",
    });
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: {},
      tokenFlag: "bwk_session",
      store,
      fetchImpl,
      now: NOW,
    });
    expect(env.BOARDWALK_API_KEY).toBe("bwk_cached");
    expect(calls).toHaveLength(0); // no network
  });

  it("re-mints when the cached key is within the expiry skew", async () => {
    const store = CredentialStore.atConfigDir(dir);
    store.putInferenceKey("https://api.test|acme", {
      token: "bwk_stale",
      expiresAt: NOW + 1000, // expires ~now → inside the 1-day skew
      id: "01H_old",
    });
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: {},
      tokenFlag: "bwk_session",
      store,
      fetchImpl,
      now: NOW,
    });
    expect(env.BOARDWALK_API_KEY).toBe("bwk_minted");
    expect(calls).toHaveLength(1);
  });

  it("respects a user-set BOARDWALK_API_KEY — returns {} and never mints", async () => {
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: { BOARDWALK_API_KEY: "bwk_users_own" },
      tokenFlag: "bwk_session",
      fetchImpl,
      now: NOW,
    });
    expect(env).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("returns {} when no org can be resolved", async () => {
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: null,
      env: {},
      tokenFlag: "bwk_session",
      fetchImpl,
      now: NOW,
    });
    expect(env).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("stays silent (no hint, no network) when logged out with no --token and no cached key", async () => {
    const store = CredentialStore.atConfigDir(dir); // empty: no session
    const { fetchImpl, calls } = mintStub(MINT_OK);
    const logs: string[] = [];
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: {},
      store,
      fetchImpl,
      now: NOW,
      log: (line) => logs.push(line),
    });
    expect(env).toEqual({});
    expect(calls).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it("returns {} and logs a hint when minting fails (never throws)", async () => {
    const store = CredentialStore.atConfigDir(dir);
    const { fetchImpl } = mintStub({ status: 403, body: { error: { message: "no scope" } } });
    const logs: string[] = [];
    const env = await resolveInferenceEnv({
      config: cfg(dir),
      orgSlug: "acme",
      env: {},
      tokenFlag: "bwk_session",
      store,
      fetchImpl,
      now: NOW,
      log: (line) => logs.push(line),
    });
    expect(env).toEqual({});
    expect(logs.join("\n")).toMatch(/boardwalk login|inference key/i);
    expect(store.getInferenceKey("https://api.test|acme")).toBeNull();
  });
});
