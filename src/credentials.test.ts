// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, type StoredSession } from "./credentials.js";

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    accessToken: "tok-123",
    refreshToken: "refresh-123",
    expiresAt: 1_800_000_000_000,
    clientId: "client_x",
    tokenEndpoint: "https://auth.example/oauth/token",
    scope: "openid",
    ...over,
  };
}

describe("CredentialStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-cred-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no file exists", () => {
    expect(CredentialStore.atConfigDir(dir).getSession()).toBeNull();
  });

  it("round-trips a session", () => {
    const store = CredentialStore.atConfigDir(dir);
    const s = session();
    store.putSession(s);
    expect(store.getSession()).toEqual(s);
  });

  it("creates missing parent directories on write", () => {
    // The config dir often doesn't exist yet on first `login`; write() must mkdir -p its
    // parent. Uses node:path dirname so the parent is resolved correctly on every platform.
    const file = join(dir, "nested", "deeper", "credentials.json");
    const store = new CredentialStore(file);
    const s = session();
    store.putSession(s);
    expect(store.getSession()).toEqual(s);
  });

  it("writes the file with 0600 permissions", () => {
    const store = CredentialStore.atConfigDir(dir);
    store.putSession(session());
    const mode = statSync(join(dir, "credentials.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("clear removes the session", () => {
    const store = CredentialStore.atConfigDir(dir);
    store.putSession(session());
    store.clear();
    expect(store.getSession()).toBeNull();
  });

  it("clear is idempotent when no file exists", () => {
    expect(() => {
      CredentialStore.atConfigDir(dir).clear();
    }).not.toThrow();
  });

  it("returns null for a malformed credentials file", () => {
    const file = join(dir, "credentials.json");
    writeFileSync(file, "{ not json");
    expect(new CredentialStore(file).getSession()).toBeNull();
  });

  it("returns null when the session lacks an access token", () => {
    const file = join(dir, "credentials.json");
    writeFileSync(file, JSON.stringify({ session: { refreshToken: "x" } }));
    expect(new CredentialStore(file).getSession()).toBeNull();
  });

  describe("inference key cache", () => {
    const key = { token: "bwk_inf", expiresAt: 1_900_000_000_000, id: "01H_k" };

    it("round-trips an inference key by cache key", () => {
      const store = CredentialStore.atConfigDir(dir);
      store.putInferenceKey("host|acme", key);
      expect(store.getInferenceKey("host|acme")).toEqual(key);
      expect(store.getInferenceKey("host|other")).toBeNull();
    });

    it("putInferenceKey preserves the session (and vice-versa)", () => {
      const store = CredentialStore.atConfigDir(dir);
      const s = session();
      store.putSession(s);
      store.putInferenceKey("host|acme", key);
      expect(store.getSession()).toEqual(s);
      expect(store.getInferenceKey("host|acme")).toEqual(key);
      // Re-writing the session must not drop the cached key.
      store.putSession(session({ accessToken: "tok-456" }));
      expect(store.getInferenceKey("host|acme")).toEqual(key);
    });

    it("clear removes cached inference keys too", () => {
      const store = CredentialStore.atConfigDir(dir);
      store.putInferenceKey("host|acme", key);
      store.clear();
      expect(store.getInferenceKey("host|acme")).toBeNull();
    });

    it("ignores a malformed cached key entry", () => {
      const file = join(dir, "credentials.json");
      writeFileSync(file, JSON.stringify({ inferenceKeys: { "host|acme": { token: 123 } } }));
      expect(new CredentialStore(file).getInferenceKey("host|acme")).toBeNull();
    });
  });
});
