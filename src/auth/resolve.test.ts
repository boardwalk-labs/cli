import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, type StoredSession } from "../credentials.js";
import type { CliConfig } from "../config.js";
import { resolveToken } from "./resolve.js";
import type { FetchLike } from "./pkce.js";

const config: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://auth.x",
  oauthClientId: "client_1",
  loopbackPort: 53682,
  configDir: "/unused",
};

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    accessToken: "stored-at",
    refreshToken: "stored-rt",
    expiresAt: null,
    clientId: "client_1",
    tokenEndpoint: "https://auth.x/oauth/token",
    scope: "openid",
    ...over,
  };
}

describe("resolveToken", () => {
  let dir: string;
  let store: CredentialStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-resolve-"));
    store = CredentialStore.atConfigDir(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the --token flag over everything", async () => {
    store.putSession(session());
    const token = await resolveToken({
      config,
      store,
      tokenFlag: "flag-token",
      env: { BOARDWALK_API_KEY: "env-key" },
    });
    expect(token).toBe("flag-token");
  });

  it("uses BOARDWALK_API_KEY when no flag is given", async () => {
    store.putSession(session());
    const token = await resolveToken({ config, store, env: { BOARDWALK_API_KEY: "env-key" } });
    expect(token).toBe("env-key");
  });

  it("uses a valid stored session token", async () => {
    store.putSession(session({ expiresAt: null }));
    const token = await resolveToken({ config, store, env: {} });
    expect(token).toBe("stored-at");
  });

  it("throws when nothing is available", async () => {
    await expect(resolveToken({ config, store, env: {} })).rejects.toThrow(/Not authenticated/);
  });

  it("refreshes an expired session and persists the new token", async () => {
    store.putSession(session({ expiresAt: 1_000 }));
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "fresh-at", refresh_token: "fresh-rt", expires_in: 3600 }),
          {
            status: 200,
          },
        ),
      )) as FetchLike;

    const token = await resolveToken({ config, store, env: {}, fetchImpl, now: 5_000 });
    expect(token).toBe("fresh-at");
    // Persisted: the new token + rotated refresh token are saved.
    expect(store.getSession()?.accessToken).toBe("fresh-at");
    expect(store.getSession()?.refreshToken).toBe("fresh-rt");
  });

  it("throws when an expired session has no refresh token", async () => {
    store.putSession(session({ expiresAt: 1_000, refreshToken: null }));
    await expect(resolveToken({ config, store, env: {}, now: 5_000 })).rejects.toThrow(
      /session has expired/,
    );
  });
});
