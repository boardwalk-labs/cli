// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatRuns, runRuns } from "./runs.js";
import type { RunListItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const NOW = 1_700_000_000_000;

function run(over: Partial<RunListItem> = {}): RunListItem {
  return {
    id: "run_01HABCDEFGHJKMNPQRSTVWXYZ0",
    workflowId: "wf_1",
    workflowName: "nightly-summary",
    status: "completed",
    triggerKind: "cron",
    createdAt: NOW - 2 * 3600 * 1000, // 2h ago
    startedAt: NOW - 2 * 3600 * 1000,
    completedAt: NOW - 2 * 3600 * 1000 + 83_000,
    runtimeSeconds: 83, // 1m 23s
    ...over,
  };
}

/** A fetch that answers the runs GET with `body` and records the URLs it was called with. */
function runsFetch(body: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as FetchLike;
  return { fetchImpl, urls };
}

describe("formatRuns", () => {
  it("renders a header + one row per run with workflow, status, trigger, age, duration", () => {
    const out = formatRuns("acme-corp", [run()], NOW).join("\n");
    expect(out).toContain("Runs · acme-corp  (1)");
    expect(out).toMatch(/RUN ID\s+WORKFLOW\s+STATUS\s+TRIGGER\s+AGE\s+DURATION/);
    expect(out).toContain("run_01HABCDEFGHJKMNPQRSTVWXYZ0");
    expect(out).toContain("nightly-summary");
    expect(out).toContain("completed");
    expect(out).toContain("cron");
    expect(out).toMatch(/2h/);
    expect(out).toMatch(/1m 23s/);
  });

  it("shows — duration for an in-flight run and falls back to the workflow id when unnamed", () => {
    const out = formatRuns(
      "acme-corp",
      [run({ status: "running", runtimeSeconds: 0, workflowName: null })],
      NOW,
    ).join("\n");
    expect(out).toContain("running");
    expect(out).toContain("wf_1"); // no name → workflow id
    expect(out).toMatch(/running.*—/s);
  });

  it("truncates a long workflow name with an ellipsis", () => {
    const out = formatRuns(
      "acme-corp",
      [run({ workflowName: "an-extremely-long-workflow-name-that-overflows" })],
      NOW,
    ).join("\n");
    expect(out).toContain("…");
  });

  it("reports an empty window cleanly", () => {
    expect(formatRuns("acme-corp", [], NOW)).toEqual(["No runs for acme-corp in this window."]);
  });
});

describe("runRuns", () => {
  it("fetches the org's runs and renders the table", async () => {
    const { fetchImpl, urls } = runsFetch({ runs: [run()], nextCursor: null });
    const lines: string[] = [];
    await runRuns(
      { org: "acme-corp", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(urls).toEqual(["https://api.x/v1/orgs/acme-corp/runs"]);
    expect(lines.join("\n")).toContain("nightly-summary");
  });

  it("passes --status and --limit through as query params", async () => {
    const { fetchImpl, urls } = runsFetch({ runs: [], nextCursor: null });
    await runRuns(
      { org: "acme-corp", status: "failed", limit: "20", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    expect(urls).toEqual(["https://api.x/v1/orgs/acme-corp/runs?status=failed&limit=20"]);
  });

  it("hints when more runs are available (nextCursor present)", async () => {
    const { fetchImpl } = runsFetch({ runs: [run()], nextCursor: "abc" });
    const lines: string[] = [];
    await runRuns(
      { org: "acme-corp", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(lines.join("\n")).toMatch(/More runs available/);
  });

  it("prints raw JSON with --json", async () => {
    const { fetchImpl } = runsFetch({ runs: [run()], nextCursor: null });
    const lines: string[] = [];
    await runRuns(
      { org: "acme-corp", json: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    const parsed = JSON.parse(lines.join("\n")) as { runs: RunListItem[] };
    expect(parsed.runs[0]?.id).toBe("run_01HABCDEFGHJKMNPQRSTVWXYZ0");
    expect(lines.join("\n")).not.toContain("RUN ID");
  });

  it("rejects an invalid --limit without making a request", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as FetchLike;
    await expect(
      runRuns(
        { org: "acme-corp", limit: "0", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/Invalid --limit/);
    expect(called).toBe(false);
  });

  it("requires an org when none is given and no project is linked", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as FetchLike;
    await expect(
      runRuns(
        { token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, cwd: "/tmp/boardwalk-no-link-xyz" },
      ),
    ).rejects.toThrow(/No org specified/);
    expect(called).toBe(false);
  });
});
