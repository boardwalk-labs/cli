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

  it("shows the run's spend and the cache share of input when the server reports them", () => {
    const out = formatRunDetail(detail({ costUsd: 1.25, cachedTokensIn: 9_075 }), NOW).join("\n");
    expect(out).toMatch(/Spend\s+\$1\.25/);
    // 9,075 of 12,100 input tokens ⇒ 75% cached, shown inline on the token line.
    expect(out).toMatch(/Tokens\s+18\.4K\s+\(12\.1K in, 75% cached · 6\.3K out\)/);
  });

  it("renders sub-cent spend at 4dp rather than a misleading $0.00", () => {
    expect(formatRunDetail(detail({ costUsd: 0.0031 }), NOW).join("\n")).toMatch(
      /Spend\s+\$0\.0031/,
    );
    expect(formatRunDetail(detail({ costUsd: 0 }), NOW).join("\n")).toMatch(/Spend\s+\$0\.00/);
  });

  it("omits Spend entirely when the server doesn't report it (never a fake $0.00)", () => {
    const out = formatRunDetail(detail(), NOW).join("\n");
    expect(out).not.toContain("Spend");
    // …and with no cache data the token line stays exactly as before.
    expect(out).toMatch(/Tokens\s+18\.4K\s+\(12\.1K in · 6\.3K out\)/);
  });

  it("shows the curated error for a failed run", () => {
    const out = formatRunDetail(
      detail({ status: "failed", error: { code: "TOOL_ERROR", message: "merge tool exited 1" } }),
      NOW,
    ).join("\n");
    expect(out).toMatch(/Status\s+failed/);
    expect(out).toMatch(/Error\s+TOOL_ERROR: merge tool exited 1/);
    // No hint on this failure ⇒ no Hint row at all.
    expect(out).not.toContain("Hint");
  });

  it("shows the hint on its own row when the failure carried one", () => {
    const out = formatRunDetail(
      detail({
        status: "failed",
        error: {
          code: "VALIDATION",
          message: 'agent() got a string ("bash") in `tools`.',
          hint: 'Built-in tools are on by default — write `builtins: ["bash"]`.',
        },
      }),
      NOW,
    ).join("\n");
    expect(out).toMatch(/Error\s+VALIDATION: agent\(\) got a string/);
    expect(out).toMatch(/Hint\s+Built-in tools are on by default/);
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

  it("maps a 404 on a run id to a friendly 'no run found' error, not the raw GET path", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404 }),
      )) as FetchLike;
    await expect(
      runRuns(
        { runId: "run_ghost", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
      ),
    ).rejects.toThrow(/No run "run_ghost" found/);
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

// ── event fixtures for --logs / --follow ──
function phaseEvent(name: string, seq: number): Record<string, unknown> {
  return { kind: "phase", name, id: `phase-${String(seq)}`, runId: "r", turnId: "tt", seq, t: seq };
}
function outputEvent(text: string, seq: number): Record<string, unknown> {
  return { kind: "program_output", stream: "stdout", text, runId: "r", turnId: "tt", seq, t: seq };
}
function statusEvent(status: string, seq: number): Record<string, unknown> {
  return { kind: "run_status", status, runId: "r", turnId: "tt", seq, t: seq };
}
function sseFrames(rows: { id: number; event: Record<string, unknown> }[]): string {
  return rows.map((r) => `id: ${String(r.id)}\ndata: ${JSON.stringify(r.event)}\n\n`).join("");
}

/** Route the fetch by URL: SSE for /stream, JSON for /events and the workflow/runs endpoints. */
function routeFetch(routes: {
  stream?: string;
  events?: unknown;
  workflows?: unknown[];
  workflowRuns?: unknown;
}): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("/stream")) {
      return Promise.resolve(
        new Response(routes.stream ?? "", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    }
    if (url.includes("/events")) {
      return Promise.resolve(
        new Response(JSON.stringify(routes.events ?? { events: [], done: true })),
      );
    }
    if (/\/workflows\/[^/]+\/runs/.test(url)) {
      return Promise.resolve(
        new Response(JSON.stringify(routes.workflowRuns ?? { runs: [], nextCursor: null })),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ workflows: routes.workflows ?? [] })));
  }) as FetchLike;
  return { fetchImpl, urls };
}

describe("runRuns --logs", () => {
  it("renders the run's events (default channels: phase + lifecycle, not program_output)", async () => {
    const { fetchImpl, urls } = routeFetch({
      events: {
        events: [
          { cursor: 1, event: phaseEvent("Clone", 1) },
          { cursor: 2, event: outputEvent("hello stdout", 2) },
          { cursor: 3, event: statusEvent("completed", 3) },
        ],
        done: true,
      },
    });
    const out: string[] = [];
    await runRuns(
      { runId: "run_x", logs: true, token: "t" },
      { config: CONFIG, fetchImpl, write: (t) => out.push(t), now: NOW },
    );
    const text = out.join("");
    expect(urls).toEqual(["https://api.x/v1/runs/run_x/events"]);
    expect(text).toContain("▸ Clone"); // phase channel (default-on)
    expect(text).toContain("workflow completed"); // lifecycle channel (default-on)
    expect(text).not.toContain("hello stdout"); // program_output → log channel (off by default)
  });

  it("includes program output with --verbose", async () => {
    const { fetchImpl } = routeFetch({
      events: { events: [{ cursor: 1, event: outputEvent("hello stdout", 1) }], done: true },
    });
    const out: string[] = [];
    await runRuns(
      { runId: "run_x", logs: true, verbose: true, token: "t" },
      { config: CONFIG, fetchImpl, write: (t) => out.push(t), now: NOW },
    );
    expect(out.join("")).toContain("hello stdout");
  });

  it("rejects --logs without a run id (no request made)", async () => {
    const { fetchImpl, urls } = routeFetch({});
    await expect(
      runRuns(
        { logs: true, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, write: () => undefined },
      ),
    ).rejects.toThrow(/need a run id/);
    expect(urls).toEqual([]);
  });

  it("rejects --logs and --follow together", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runRuns(
        { runId: "run_x", logs: true, follow: true, token: "t" },
        { config: CONFIG, fetchImpl, write: () => undefined },
      ),
    ).rejects.toThrow(/either --logs or --follow/);
  });
});

describe("runRuns --follow", () => {
  it("streams events and stops on a terminal run_status (no snapshot fetch)", async () => {
    const { fetchImpl, urls } = routeFetch({
      stream: sseFrames([
        { id: 1, event: phaseEvent("Run", 1) },
        { id: 2, event: statusEvent("completed", 2) },
      ]),
    });
    const out: string[] = [];
    await runRuns(
      { runId: "run_x", follow: true, token: "t" },
      {
        config: CONFIG,
        fetchImpl,
        write: (t) => out.push(t),
        now: NOW,
        sleep: () => Promise.resolve(),
      },
    );
    expect(out.join("")).toContain("▸ Run");
    expect(out.join("")).toContain("workflow completed");
    expect(urls).toEqual(["https://api.x/v1/runs/run_x/stream"]); // terminal frame ⇒ no /events check
  });

  it("confirms terminal via the snapshot when the stream closes without a run_status frame", async () => {
    const { fetchImpl, urls } = routeFetch({
      stream: sseFrames([{ id: 1, event: phaseEvent("Run", 1) }]), // closes, no terminal frame
      events: { events: [{ cursor: 2, event: outputEvent("tail line", 2) }], done: true },
    });
    const out: string[] = [];
    await runRuns(
      { runId: "run_x", follow: true, verbose: true, token: "t" },
      {
        config: CONFIG,
        fetchImpl,
        write: (t) => out.push(t),
        now: NOW,
        sleep: () => Promise.resolve(),
      },
    );
    expect(out.join("")).toContain("▸ Run");
    expect(out.join("")).toContain("tail line"); // drained from the snapshot
    expect(urls).toEqual([
      "https://api.x/v1/runs/run_x/stream",
      "https://api.x/v1/runs/run_x/events?since=1", // done-check from the last cursor
    ]);
  });
});

describe("runRuns --workflow", () => {
  it("resolves a slug and lists that workflow's runs", async () => {
    const { fetchImpl, urls } = routeFetch({
      workflows: [{ id: "01KV0000000000000000000007", slug: "nightly" }],
      workflowRuns: { runs: [run()], nextCursor: null },
    });
    const lines: string[] = [];
    await runRuns(
      { org: "acme", workflow: "nightly", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(urls).toEqual([
      "https://api.x/v1/orgs/acme/workflows", // slug → id resolution
      "https://api.x/v1/orgs/acme/workflows/01KV0000000000000000000007/runs",
    ]);
    expect(lines.join("\n")).toContain("acme / nightly");
  });

  it("uses a workflow id directly without a resolution lookup", async () => {
    const { fetchImpl, urls } = routeFetch({ workflowRuns: { runs: [], nextCursor: null } });
    await runRuns(
      { org: "acme", workflow: "01KV0000000000000000000007", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    expect(urls).toEqual(["https://api.x/v1/orgs/acme/workflows/01KV0000000000000000000007/runs"]);
  });
});
