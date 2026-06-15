// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatRunDetail, formatRuns, runRuns } from "./runs.js";
import type { RunDetail, RunListItem } from "../client.js";
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
    workflowSlug: "nightly-summary",
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
      [run({ status: "running", runtimeSeconds: 0, workflowSlug: null })],
      NOW,
    ).join("\n");
    expect(out).toContain("running");
    expect(out).toContain("wf_1"); // no name → workflow id
    expect(out).toMatch(/running.*—/s);
  });

  it("truncates a long workflow slug with an ellipsis", () => {
    const out = formatRuns(
      "acme-corp",
      [run({ workflowSlug: "an-extremely-long-workflow-name-that-overflows" })],
      NOW,
    ).join("\n");
    expect(out).toContain("…");
  });

  it("reports an empty window cleanly", () => {
    expect(formatRuns("acme-corp", [], NOW)).toEqual(["No runs for acme-corp in this window."]);
  });
});

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    ...run(),
    outcomeStatus: null,
    tokensIn: 12_100,
    tokensOut: 6_300,
    error: null,
    ...over,
  };
}

describe("formatRunDetail", () => {
  it("renders the run's fields, times, duration, and tokens", () => {
    const out = formatRunDetail(detail(), NOW).join("\n");
    expect(out).toContain("Run run_01HABCDEFGHJKMNPQRSTVWXYZ0");
    expect(out).toMatch(/Workflow\s+nightly-summary/);
    expect(out).toMatch(/Status\s+completed/);
    expect(out).toMatch(/Trigger\s+cron/);
    expect(out).toMatch(/Created\s+2023-11-14 .* UTC\s+\(2h ago\)/);
    expect(out).toMatch(/Duration\s+1m 23s/);
    expect(out).toMatch(/Tokens\s+18\.4K\s+\(12\.1K in · 6\.3K out\)/);
    expect(out).not.toContain("Error");
  });

  it("shows the curated error for a failed run", () => {
    const out = formatRunDetail(
      detail({ status: "failed", error: { code: "TOOL_ERROR", message: "merge tool exited 1" } }),
      NOW,
    ).join("\n");
    expect(out).toMatch(/Status\s+failed/);
    expect(out).toMatch(/Error\s+TOOL_ERROR: merge tool exited 1/);
  });

  it("omits started/finished/tokens when absent (in-flight run)", () => {
    const out = formatRunDetail(
      detail({
        status: "running",
        startedAt: null,
        completedAt: null,
        runtimeSeconds: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      NOW,
    ).join("\n");
    expect(out).not.toContain("Started");
    expect(out).not.toContain("Finished");
    expect(out).not.toContain("Tokens");
    expect(out).toMatch(/Duration\s+—/);
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

  it("shows one run's detail (via /v1/runs/:id) when a run id is given — no org needed", async () => {
    const { fetchImpl, urls } = runsFetch({ run: { ...detail(), id: "run_xyz" } });
    const lines: string[] = [];
    await runRuns(
      { runId: "run_xyz", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(urls).toEqual(["https://api.x/v1/runs/run_xyz"]);
    const out = lines.join("\n");
    expect(out).toContain("Run run_xyz");
    expect(out).toMatch(/Workflow\s+nightly-summary/);
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
