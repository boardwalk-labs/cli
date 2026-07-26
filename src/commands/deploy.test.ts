// SPDX-License-Identifier: MIT

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDeployWarnings, makeCreateConfirmer, runDeploy } from "./deploy.js";
import type { Prompter } from "../prompt.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const WF_ID = "01KV0000000000000000000007";

function prompterAnswering(answer: boolean): {
  prompter: Prompter;
  confirm: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(() => Promise.resolve(answer));
  const prompter: Prompter = {
    confirm,
    select: () => Promise.reject(new Error("unused")),
    multiselect: () => Promise.reject(new Error("unused")),
  };
  return { prompter, confirm };
}

describe("makeCreateConfirmer", () => {
  it("--yes skips the gate entirely (undefined — deployWithLink never asks)", () => {
    expect(makeCreateConfirmer({ yes: true, interactive: true })).toBeUndefined();
  });

  it("asks the prompter interactively, naming the slug + org", async () => {
    const { prompter, confirm } = prompterAnswering(true);
    const gate = makeCreateConfirmer({ yes: false, interactive: true, prompter });
    expect(gate).toBeDefined();
    await expect(gate?.({ slug: "triage", orgSlug: "acme" })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('Create new workflow "triage" in org "acme"?');
  });

  it("propagates a decline", async () => {
    const { prompter } = prompterAnswering(false);
    const gate = makeCreateConfirmer({ yes: false, interactive: true, prompter });
    await expect(gate?.({ slug: "triage", orgSlug: "acme" })).resolves.toBe(false);
  });

  it("HARD-ERRORS instead of hanging when there is no TTY and no --yes (CI)", async () => {
    const gate = makeCreateConfirmer({ yes: false, interactive: false });
    let caught: unknown;
    try {
      await gate?.({ slug: "triage", orgSlug: "acme" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: expect.stringContaining("CREATE"),
      hint: expect.stringContaining("--yes"),
    });
  });
});

describe("logDeployWarnings", () => {
  it("prints nothing when the server returned no warnings", () => {
    const lines: string[] = [];
    logDeployWarnings((l) => lines.push(l), []);
    expect(lines).toEqual([]);
  });

  it("prints a header + one bullet per derivation warning", () => {
    const lines: string[] = [];
    logDeployWarnings(
      (l) => lines.push(l),
      ["input field `when` degraded to raw JSON", "output field `blob` degraded to raw JSON"],
    );
    expect(lines).toEqual([
      "⚠ derivation warnings:",
      "  - input field `when` degraded to raw JSON",
      "  - output field `blob` degraded to raw JSON",
    ]);
  });
});

describe("deploy --run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-deployrun-"));
    writeFileSync(
      join(dir, "workflow.jsonc"),
      JSON.stringify({ slug: "nightly-summary", triggers: [{ kind: "manual" }] }),
    );
    writeFileSync(
      join(dir, "index.ts"),
      `export default async function run(): Promise<string> { return "ok"; }`,
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Deploy endpoints + the run endpoints `--run` chains into. */
  function platform(): { fetchImpl: FetchLike; calls: { method: string; url: string }[] } {
    const calls: { method: string; url: string }[] = [];
    const json = (value: unknown, status = 200): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
    const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      calls.push({ method, url });

      if (url.endsWith("/v1/me")) {
        return json({
          user: { id: "u1", email: "a@b.c", name: null },
          memberships: [{ orgId: "o1", slug: "acme", role: "owner", name: "acme", plan: null }],
        });
      }
      if (method === "POST" && url.endsWith("/artifact-upload-url")) {
        return json({ uploadUrl: "https://s3.x/put", contentType: "application/gzip" });
      }
      if (url.startsWith("https://s3.x/"))
        return Promise.resolve(new Response(null, { status: 200 }));
      if (method === "POST" && url.endsWith("/runs")) {
        return json({
          run: {
            id: "run1",
            workflowId: WF_ID,
            status: "queued",
            outcomeStatus: null,
            startedAt: null,
            completedAt: null,
          },
        });
      }
      if (/\/v1\/runs\/[^/]+\/events/.test(url)) return json({ events: [] });
      if (/\/v1\/runs\/[^/]+$/.test(url)) {
        return json({
          run: {
            id: "run1",
            workflowId: WF_ID,
            status: "completed",
            outcomeStatus: "success",
            startedAt: null,
            completedAt: null,
          },
        });
      }
      if (/\/v1\/orgs\/[^/]+\/workflows$/.test(url) && method === "GET") {
        return json({ workflows: [] });
      }
      // create/update workflow + finalize version
      return json({
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v1" },
        version: { id: "v1", number: 1, createdAt: 0 },
        warnings: [],
      });
    };
    return { fetchImpl, calls };
  }

  it("deploys, then triggers the version it just shipped", async () => {
    const { fetchImpl, calls } = platform();
    const lines: string[] = [];
    await runDeploy(
      { file: dir, check: false, yes: true, run: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), interactive: false },
    );
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/runs"))).toBe(true);
    expect(lines.join("\n")).toContain("run run1 triggered");
  });

  it("does NOT trigger without --run — deploy alone just deploys", async () => {
    const { fetchImpl, calls } = platform();
    await runDeploy(
      { file: dir, check: false, yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined, interactive: false },
    );
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/runs"))).toBe(false);
  });
});
