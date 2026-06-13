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

  it("whoami reports the API-key method", async () => {
    const c = config(dir);
    await runLogin({ config: c }, { token: "bwk_x" });
    const lines: string[] = [];
    runWhoami({ config: c, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain("API key");
  });

  it("logout clears the stored key", async () => {
    const c = config(dir);
    await runLogin({ config: c }, { token: "bwk_x" });
    runLogout({ config: c, log: () => undefined });
    expect(() => {
      runWhoami({ config: c, log: () => undefined });
    }).toThrow(/Not logged in/);
  });
});
