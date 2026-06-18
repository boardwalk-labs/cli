// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatStatus, runStatus, type StatusReport } from "./status.js";
import { CredentialStore } from "../credentials.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const NOW = 1_700_000_000_000;

function config(dir: string): CliConfig {
  return {
    apiBaseUrl: "https://api.x",
    issuerUrl: "https://api.x",
    oauthClientId: "boardwalk-cli",
    loopbackPort: 53682,
    configDir: dir,
  };
}

/** A fetch that answers `GET /v1/me` with `body` at `status`, recording the URLs it sees. */
function meFetch(body: unknown, status = 200): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as FetchLike;
  return { fetchImpl, urls };
}

const ME_OK = {
  user: { id: "user_1", email: "ada@example.com", name: "Ada Lovelace" },
  memberships: [
    { orgId: "o1", role: "owner", slug: "demo-org", name: "Demo Org" },
    { orgId: "o2", role: "member", slug: "acme", name: "Acme" },
  ],
};

describe("formatStatus", () => {
  function base(over: Partial<StatusReport> = {}): StatusReport {
    return {
      version: "0.1.5",
      host: { url: "https://api.x", source: "default" },
      auth: { kind: "oauth", scope: "workflows", expiresAt: NOW + 13 * 3_600_000 },
      account: {
        kind: "ok",
        email: "ada@example.com",
        name: "Ada Lovelace",
        orgs: [
          { slug: "demo-org", role: "owner" },
          { slug: "acme", role: "member" },
        ],
      },
      project: { orgSlug: "demo-org", workflowId: "wf_abc123" },
      ...over,
    };
  }

  it("renders host, verified account, oauth auth, orgs, and the project link", () => {
    const out = formatStatus(base(), NOW).join("\n");
    expect(out).toContain("Boardwalk CLI 0.1.5");
    expect(out).toMatch(/Host\s+https:\/\/api\.x\s+\(default\)/);
    expect(out).toMatch(/Account\s+✓ ada@example\.com \(Ada Lovelace\)/);
    expect(out).toMatch(/Auth\s+OAuth session · scope=workflows · expires in 13h/);
    expect(out).toMatch(/Orgs\s+demo-org \(owner\) · acme \(member\)/);
    expect(out).toMatch(/Project\s+demo-org \/ wf_abc123/);
  });

  it("labels a self-host / dev host by the env var that set it", () => {
    const out = formatStatus(
      base({ host: { url: "https://boardwalk.example.com", source: "BOARDWALK_API_URL" } }),
      NOW,
    ).join("\n");
    expect(out).toMatch(/Host\s+https:\/\/boardwalk\.example\.com\s+\(BOARDWALK_API_URL\)/);
  });

  it("shows the not-linked hint when there is no project link", () => {
    const out = formatStatus(base({ project: null }), NOW).join("\n");
    expect(out).toMatch(/Project\s+not linked — run `boardwalk deploy`/);
  });

  it("omits the name parens when the account has no display name", () => {
    const out = formatStatus(
      base({ account: { kind: "ok", email: "ada@example.com", name: null, orgs: [] } }),
      NOW,
    ).join("\n");
    expect(out).toMatch(/Account\s+✓ ada@example\.com$/m);
    expect(out).not.toContain("Orgs"); // no memberships → no Orgs line
  });

  it("reports a rejected token and omits Orgs", () => {
    const out = formatStatus(base({ account: { kind: "rejected" } }), NOW).join("\n");
    expect(out).toMatch(/Account\s+✗ token rejected — run `boardwalk login`/);
    expect(out).not.toContain("Orgs");
  });

  it("reports an unreachable host softly", () => {
    const out = formatStatus(base({ account: { kind: "unreachable" } }), NOW).join("\n");
    expect(out).toMatch(/Account\s+\? could not verify \(host unreachable\)/);
  });

  it("reports not-logged-in and omits the Auth line entirely", () => {
    const out = formatStatus(base({ account: { kind: "none" }, auth: { kind: "none" } }), NOW).join(
      "\n",
    );
    expect(out).toMatch(/Account\s+✗ not logged in — run `boardwalk login`/);
    expect(out).not.toContain("Auth ");
  });

  it("describes env / flag / api-key auth and an expired oauth session", () => {
    expect(formatStatus(base({ auth: { kind: "env" } }), NOW).join("\n")).toContain(
      "BOARDWALK_API_KEY (env)",
    );
    expect(formatStatus(base({ auth: { kind: "flag" } }), NOW).join("\n")).toContain(
      "--token (one-off)",
    );
    expect(formatStatus(base({ auth: { kind: "apiKey" } }), NOW).join("\n")).toContain(
      "API key (stored)",
    );
    expect(
      formatStatus(base({ auth: { kind: "oauth", scope: null, expiresAt: NOW - 1 } }), NOW).join(
        "\n",
      ),
    ).toMatch(/scope=— · expired/);
  });
});

describe("runStatus", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-status-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies an explicit --token via /v1/me and prints the account + orgs", async () => {
    const { fetchImpl, urls } = meFetch(ME_OK);
    const lines: string[] = [];
    const exits: number[] = [];
    await runStatus(
      { token: "bwk_live" },
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: (c) => exits.push(c),
      },
    );
    expect(urls).toEqual(["https://api.x/v1/me"]);
    const out = lines.join("\n");
    expect(out).toMatch(/Account\s+✓ ada@example\.com \(Ada Lovelace\)/);
    expect(out).toMatch(/Orgs\s+demo-org \(owner\) · acme \(member\)/);
    expect(out).toContain("--token (one-off)");
    expect(exits).toEqual([]); // valid → exit 0 (untouched)
  });

  it("sets exit 1 and reports rejection when the server returns 401", async () => {
    const { fetchImpl } = meFetch({ error: { code: "UNAUTHORIZED", message: "bad token" } }, 401);
    const lines: string[] = [];
    const exits: number[] = [];
    await runStatus(
      { token: "bwk_bad" },
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: (c) => exits.push(c),
      },
    );
    expect(lines.join("\n")).toMatch(/Account\s+✗ token rejected/);
    expect(exits).toEqual([1]);
  });

  it("uses BOARDWALK_API_KEY from the env when no flag is given", async () => {
    const { fetchImpl } = meFetch(ME_OK);
    const lines: string[] = [];
    await runStatus(
      {},
      {
        config: config(dir),
        fetchImpl,
        env: { BOARDWALK_API_KEY: "bwk_env" },
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: () => undefined,
      },
    );
    expect(lines.join("\n")).toContain("BOARDWALK_API_KEY (env)");
    expect(lines.join("\n")).toMatch(/Account\s+✓ ada@example\.com/);
  });

  it("reports not-logged-in (exit 1) and makes no request when there is no credential", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as FetchLike;
    const lines: string[] = [];
    const exits: number[] = [];
    await runStatus(
      {},
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: (c) => exits.push(c),
      },
    );
    expect(called).toBe(false);
    expect(lines.join("\n")).toMatch(/Account\s+✗ not logged in/);
    expect(exits).toEqual([1]);
  });

  it("verifies a stored OAuth login and shows its scope + expiry", async () => {
    CredentialStore.atConfigDir(dir).putSession({
      accessToken: "tok_live",
      refreshToken: "r",
      expiresAt: NOW + 9 * 3_600_000,
      clientId: "boardwalk-cli",
      tokenEndpoint: "https://api.x/oauth/token",
      scope: "workflows",
    });
    const { fetchImpl, urls } = meFetch(ME_OK);
    const lines: string[] = [];
    await runStatus(
      {},
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: () => undefined,
      },
    );
    expect(urls).toEqual(["https://api.x/v1/me"]);
    expect(lines.join("\n")).toMatch(/Auth\s+OAuth session · scope=workflows · expires in 9h/);
    expect(lines.join("\n")).toMatch(/Account\s+✓ ada@example\.com/);
  });

  it("degrades to 'unreachable' (exit 0) when the host can't be reached", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as FetchLike;
    const lines: string[] = [];
    const exits: number[] = [];
    await runStatus(
      { token: "bwk_live" },
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: (c) => exits.push(c),
      },
    );
    expect(lines.join("\n")).toMatch(/Account\s+\? could not verify \(host unreachable\)/);
    expect(exits).toEqual([]); // offline but creds intact → exit 0
  });

  it("shows the project link for a linked directory", async () => {
    const { writeLink } = await import("../project.js");
    writeLink(dir, { orgSlug: "demo-org", workflowId: "wf_xyz" });
    const { fetchImpl } = meFetch(ME_OK);
    const lines: string[] = [];
    await runStatus(
      { token: "bwk_live" },
      {
        config: config(dir),
        fetchImpl,
        env: {},
        now: NOW,
        cwd: dir,
        log: (l) => lines.push(l),
        setExitCode: () => undefined,
      },
    );
    expect(lines.join("\n")).toMatch(/Project\s+demo-org \/ wf_xyz/);
  });
});
