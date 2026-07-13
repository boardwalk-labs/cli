// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogin, runLogout, runWhoami } from "./session.js";
import { CredentialStore } from "../credentials.js";
import type { CliConfig } from "../config.js";

function config(dir: string): CliConfig {
  return {
    apiBaseUrl: "https://api.x",
    issuerUrl: "https://auth.x",
    oauthClientId: null,
    loopbackPort: 53682,
    configDir: dir,
  };
}

describe("runLogin --token (first-class API-key auth)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-session-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists the API key as a non-expiring session", async () => {
    const lines: string[] = [];
    await runLogin({ config: config(dir), log: (l) => lines.push(l) }, { token: "bwk_abc" });
    const s = CredentialStore.atConfigDir(dir).getSession();
    expect(s?.accessToken).toBe("bwk_abc");
    expect(s?.expiresAt).toBeNull();
    expect(s?.tokenEndpoint).toBeNull();
    expect(lines.join("\n")).toContain("Stored API key");
  });

  it("whoami reports the API-key method (session line prints even when the probe fails)", async () => {
    const c = config(dir);
    await runLogin({ config: c }, { token: "bwk_x" });
    const lines: string[] = [];
    const offline = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    await runWhoami({ config: c, log: (l) => lines.push(l), fetchImpl: offline });
    expect(lines.join("\n")).toContain("API key");
    expect(lines.join("\n")).not.toContain("org "); // probe failed → no org lines, no error
  });

  it("whoami lists the account's orgs with their ids (OIDC trust policies pin on the id)", async () => {
    const c = config(dir);
    await runLogin({ config: c }, { token: "bwk_x" });
    const me = {
      user: { id: "user_1", email: "ada@example.com", name: null },
      memberships: [{ orgId: "01ORGDEMO", role: "owner", slug: "demo-org", plan: "solo" }],
    };
    const fetchImpl = (() =>
      Promise.resolve(new Response(JSON.stringify(me), { status: 200 }))) as typeof fetch;
    const lines: string[] = [];
    await runWhoami({ config: c, log: (l) => lines.push(l), fetchImpl });
    expect(lines.join("\n")).toContain("org demo-org (owner) id=01ORGDEMO");
  });

  it("logout clears the stored key", async () => {
    const c = config(dir);
    await runLogin({ config: c }, { token: "bwk_x" });
    runLogout({ config: c, log: () => undefined });
    await expect(runWhoami({ config: c, log: () => undefined })).rejects.toThrow(/Not logged in/);
  });
});

describe("runLogin --scopes (elevated tier)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-session-elev-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unknown tier before touching the browser flow", async () => {
    await expect(
      runLogin({ config: config(dir), log: () => undefined }, { scopes: "superuser" }),
    ).rejects.toThrow(/Unknown --scopes/);
  });

  it("errors when --scopes admin can't resolve an elevated client id (none configured)", async () => {
    // config() sets oauthClientId=null, so the `-admin` sibling can't be derived.
    await expect(
      runLogin({ config: config(dir), log: () => undefined }, { scopes: "admin" }),
    ).rejects.toThrow(/elevated client/);
  });
});
