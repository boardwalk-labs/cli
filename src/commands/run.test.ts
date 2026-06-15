// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatus, parseInput, pollToTerminal, runRun, type RunReader } from "./run.js";
import { CliError } from "../errors.js";
import type { RunSummary } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

function runSummary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run1",
    workflowId: "wf1",
    status: "running",
    outcomeStatus: null,
    startedAt: null,
    completedAt: null,
    ...over,
  };
}

interface FetchCall {
  url: string;
  method: string;
  body: string | undefined;
}

/**
 * A fake fetch that routes the deploy → trigger → poll chain `runRun` makes. `runStatuses` is the
 * queue of statuses returned by the trigger (first) and successive GET /v1/runs/:id polls.
 */
function makeFetch(opts: {
  runStatuses?: string[];
  outcome?: string | null;
  failTriggerWith?: number;
  failGetRunWith?: number;
}): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const statuses = opts.runStatuses ?? ["completed"];
  let pollIndex = 0;

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

    // Presigned PUT upload — storage host, no auth.
    if (url.startsWith("https://storage/")) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    // List workflows (deploy resolves create vs adopt).
    if (url.endsWith("/workflows") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ workflows: [] }), { status: 200 }));
    }
    // Presigned upload URL.
    if (url.endsWith("/artifact-upload-url")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ uploadUrl: "https://storage/put?sig", contentType: "application/gzip" }),
          { status: 200 },
        ),
      );
    }
    // Create workflow.
    if (url.endsWith("/workflows") && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            workflow: { id: "wf1", slug: "n", currentVersionId: null },
            version: { id: "v1", number: 1 },
          }),
          { status: 200 },
        ),
      );
    }
    // Trigger run: POST .../workflows/:id/runs
    if (url.includes("/workflows/") && url.endsWith("/runs") && method === "POST") {
      if (opts.failTriggerWith !== undefined) {
        return Promise.resolve(new Response("boom", { status: opts.failTriggerWith }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ run: runSummary({ status: statuses[0] ?? "completed" }) }), {
          status: 200,
        }),
      );
    }
    // Poll: GET /v1/runs/:id
    if (url.includes("/v1/runs/") && method === "GET") {
      if (opts.failGetRunWith !== undefined) {
        return Promise.resolve(new Response("err", { status: opts.failGetRunWith }));
      }
      const idx = Math.min(pollIndex, statuses.length - 1);
      pollIndex += 1;
      const status = statuses[idx] ?? "completed";
      return Promise.resolve(
        new Response(
          JSON.stringify({ run: runSummary({ status, outcomeStatus: opts.outcome ?? null }) }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }) as FetchLike;

  return { fetchImpl, calls };
}

/** Write a minimal workflow entry (`index.ts`) in a fresh dir so `loadProgram` can build it. */
function workflowDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-run-"));
  writeFileSync(join(dir, "index.ts"), `export const meta = { slug: "n", description: "d" };`);
  return dir;
}

describe("isTerminalStatus", () => {
  it("recognizes terminal states", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
  it("treats in-flight states as non-terminal", () => {
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("queued")).toBe(false);
    expect(isTerminalStatus("")).toBe(false);
  });
});

describe("parseInput", () => {
  it("returns undefined when no input is given", () => {
    expect(parseInput(undefined)).toBeUndefined();
  });
  it("parses inline JSON objects, arrays, and scalars", () => {
    expect(parseInput('{"a":1}')).toEqual({ a: 1 });
    expect(parseInput("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseInput('"hi"')).toBe("hi");
    expect(parseInput("42")).toBe(42);
  });
  it("throws a clear CliError on malformed JSON instead of crashing", () => {
    try {
      parseInput("{not json");
      throw new Error("expected parseInput to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toMatch(/--input is not valid JSON/);
    }
  });
});

describe("pollToTerminal", () => {
  it("polls until terminal, emitting onStatus on each change", async () => {
    const seq = ["queued", "queued", "running", "completed"];
    let i = 0;
    const client: RunReader = {
      getRun: () => Promise.resolve(runSummary({ status: seq[i++] ?? "completed" })),
    };
    const seen: string[] = [];
    const run = await pollToTerminal(client, "run1", {
      sleep: () => Promise.resolve(),
      intervalMs: 1,
      onStatus: (s) => seen.push(s),
    });
    expect(run.status).toBe("completed");
    // De-duplicated: "queued" reported once even though seen twice.
    expect(seen).toEqual(["queued", "running", "completed"]);
  });

  it("throws a timeout CliError when the run never terminates", async () => {
    const client: RunReader = { getRun: () => Promise.resolve(runSummary({ status: "running" })) };
    let t = 0;
    await expect(
      pollToTerminal(client, "run1", {
        sleep: () => Promise.resolve(),
        intervalMs: 1,
        timeoutMs: 10,
        now: () => (t += 100), // every read advances past the timeout
      }),
    ).rejects.toThrow(/did not finish within/);
  });
});

describe("runRun — happy path", () => {
  let dir: string;
  beforeEach(() => {
    dir = workflowDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deploys, triggers, polls to completion, and renders the run result", async () => {
    const { fetchImpl, calls } = makeFetch({
      runStatuses: ["running", "completed"],
      outcome: "success",
    });
    const lines: string[] = [];
    await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/run run1 triggered/);
    expect(out).toContain("──────── run result ────────");
    expect(out).toMatch(/status: {2}completed/);
    expect(out).toMatch(/outcome: success/);
    // Forwarded the correct trigger target: POST .../workflows/wf1/runs
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/workflows/wf1/runs"))).toBe(
      true,
    );
    // The run was polled (at least one GET /v1/runs/run1).
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/v1/runs/run1"))).toBe(true);
  });

  it("forwards inline JSON input as the request body", async () => {
    const { fetchImpl, calls } = makeFetch({ runStatuses: ["completed"], outcome: "success" });
    await runRun(
      { file: dir, org: "acme", token: "t", input: '{"name":"ada"}' },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    const trigger = calls.find((c) => c.method === "POST" && c.url.endsWith("/workflows/wf1/runs"));
    expect(trigger).toBeDefined();
    expect(JSON.parse(trigger?.body ?? "null")).toEqual({ input: { name: "ada" } });
  });

  it("stops early on --no-wait without polling the run", async () => {
    const { fetchImpl, calls } = makeFetch({ runStatuses: ["queued"] });
    const lines: string[] = [];
    await runRun(
      { file: dir, org: "acme", token: "t", noWait: true },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(lines.join("\n")).toMatch(/--no-wait/);
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/v1/runs/run1"))).toBe(false);
  });
});

describe("runRun — input + error mapping", () => {
  let dir: string;
  beforeEach(() => {
    dir = workflowDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects malformed --input as a validation error before triggering", async () => {
    const { fetchImpl, calls } = makeFetch({ runStatuses: ["completed"] });
    await expect(
      runRun(
        { file: dir, org: "acme", token: "t", input: "{bad" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/--input is not valid JSON/);
    // Never reached the trigger POST.
    expect(calls.some((c) => c.url.endsWith("/workflows/wf1/runs"))).toBe(false);
  });

  it("maps an auth (401) failure on trigger to a CliError carrying the status", async () => {
    const { fetchImpl } = makeFetch({ failTriggerWith: 401 });
    const err = await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).status).toBe(401);
    expect((err as CliError).hint).toMatch(/Unauthorized/);
  });

  it("maps a 5xx server failure on trigger to a CliError with the status", async () => {
    const { fetchImpl } = makeFetch({ failTriggerWith: 503 });
    const err = await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).status).toBe(503);
  });

  it("surfaces a run-not-found (404) failure while polling", async () => {
    const { fetchImpl } = makeFetch({ failGetRunWith: 404 });
    const err = await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).status).toBe(404);
  });

  it("requires an org (no --org and no link) before doing any work", async () => {
    const { fetchImpl, calls } = makeFetch({ runStatuses: ["completed"] });
    await expect(
      runRun({ file: dir, token: "t" }, { config: CONFIG, fetchImpl, log: () => undefined }),
    ).rejects.toThrow(/No org to deploy into/);
    expect(calls.some((c) => c.url.endsWith("/workflows/wf1/runs"))).toBe(false);
  });

  it("throws on a non-completed terminal status (failed run) with a dashboard hint", async () => {
    const { fetchImpl } = makeFetch({ runStatuses: ["running", "failed"], outcome: "error" });
    const lines: string[] = [];
    const err = await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/Run failed\./);
    expect((err as CliError).hint).toMatch(/dashboard/);
    // Still rendered the outcome before throwing.
    expect(lines.join("\n")).toContain("──────── run result ────────");
  });

  it("treats a cancelled run as a non-completed terminal status (cleanup + exit)", async () => {
    const { fetchImpl } = makeFetch({ runStatuses: ["running", "cancelled"] });
    const err = await runRun(
      { file: dir, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/Run cancelled\./);
  });
});
