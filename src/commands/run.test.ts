// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTerminalStatus, pollToTerminal, parseInput, runRun, type RunReader } from "./run.js";
import type { RunSummary } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";
import { CliError } from "../errors.js";

function run(status: string): RunSummary {
  return {
    id: "run1",
    workflowId: "wf1",
    status,
    outcomeStatus: status === "completed" ? "success" : null,
    startedAt: null,
    completedAt: null,
  };
}

describe("isTerminalStatus", () => {
  it("is true for completed/failed/cancelled", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("cancelled")).toBe(true);
  });
  it("is false for in-flight statuses", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("running")).toBe(false);
  });
});

describe("parseInput", () => {
  // Parsing/validating the structured input flag: default (undefined) when omitted.
  it("returns undefined when the flag is absent (the default)", () => {
    expect(parseInput(undefined)).toBeUndefined();
  });
  it("maps valid JSON to the parsed payload (object + scalar + array)", () => {
    expect(parseInput('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
    expect(parseInput("42")).toBe(42);
    expect(parseInput('["a","b"]')).toEqual(["a", "b"]);
  });
  // Malformed structured input surfaces a descriptive, user-facing error.
  it("throws a descriptive CliError on malformed JSON", () => {
    expect(() => parseInput("{bad")).toThrow(CliError);
    expect(() => parseInput("{bad")).toThrow(/--input is not valid JSON/);
    expect(() => parseInput("key=value")).toThrow(/not valid JSON/);
  });
  // Edge case: duplicate keys in a structured payload don't error in JSON, but the
  // last-wins semantics are explicit (no silent merge into both values).
  it("keeps last-wins for duplicate keys in a single JSON object", () => {
    expect(parseInput('{"a":1,"a":2}')).toEqual({ a: 2 });
  });
});

describe("pollToTerminal", () => {
  function reader(statuses: string[]): { client: RunReader; calls: () => number } {
    let i = 0;
    const state = { calls: 0 };
    const client: RunReader = {
      getRun: () => {
        state.calls += 1;
        const status = statuses[Math.min(i, statuses.length - 1)] ?? "running";
        i += 1;
        return Promise.resolve(run(status));
      },
    };
    return { client, calls: () => state.calls };
  }

  it("polls until a terminal status and returns the run", async () => {
    const { client } = reader(["pending", "running", "completed"]);
    const seen: string[] = [];
    const result = await pollToTerminal(client, "run1", {
      sleep: () => Promise.resolve(),
      onStatus: (s) => seen.push(s),
    });
    expect(result.status).toBe("completed");
    // onStatus fires only on transitions, in order.
    expect(seen).toEqual(["pending", "running", "completed"]);
  });

  it("times out with a CliError if the run never reaches a terminal state", async () => {
    const { client } = reader(["running"]);
    let clock = 0;
    await expect(
      pollToTerminal(client, "run1", {
        sleep: () => {
          clock += 10_000;
          return Promise.resolve();
        },
        timeoutMs: 5_000,
        now: () => clock,
      }),
    ).rejects.toThrow(/did not finish/);
  });
});

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter-run-test",
};

interface FetchLog {
  method: string;
  url: string;
  body: unknown;
}

/**
 * A fetch that scripts the whole `runRun` API conversation for an UNLINKED project:
 *   GET  list workflows         → [] (no match ⇒ create)
 *   POST artifact-upload-url     → presigned PUT url
 *   PUT  (presigned upload)      → 200
 *   POST workflows (create)      → { workflow, version }
 *   POST .../runs (trigger)      → run summary (`triggered`)
 *   GET  /v1/runs/run1           → run summary (`finalStatus`)
 * `failAt` lets a test make one endpoint respond with an error status.
 */
function scriptedFetch(
  finalStatus: string,
  failAt?: { url: RegExp; status: number; body?: string },
): { fetchImpl: FetchLike; log: FetchLog[] } {
  const log: FetchLog[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    log.push({ method, url, body });

    if (failAt?.url.test(url) === true) {
      return Promise.resolve(
        new Response(failAt.body ?? JSON.stringify({ error: { message: "boom" } }), {
          status: failAt.status,
        }),
      );
    }

    // Presigned upload PUT (absolute storage url; not under the API base).
    if (method === "PUT") return Promise.resolve(new Response(null, { status: 200 }));

    if (url.endsWith("/workflows") && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ workflows: [] }), { status: 200 }));
    }
    if (url.endsWith("/artifact-upload-url")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ uploadUrl: "https://storage.x/put", contentType: "application/gzip" }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/workflows") && method === "POST") {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            workflow: { id: "wf1", slug: "run-wf", currentVersionId: null },
            version: { id: "v1", number: 1 },
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ run: run("triggered") }), { status: 200 }),
      );
    }
    if (url.endsWith("/v1/runs/run1") && method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify({ run: run(finalStatus) }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({}), { status: 500 }));
  }) as FetchLike;
  return { fetchImpl, log };
}

describe("runRun (end-to-end with a real built artifact)", () => {
  let dir: string;
  let entry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-run-"));
    entry = join(dir, "wf.ts");
    writeFileSync(
      entry,
      `import { agent } from "@boardwalk-labs/workflow";
       export const meta = { slug: "run-wf", description: "d" };
       await agent("go", { model: "anthropic/claude-sonnet-4.5" });`,
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("maps a valid run to the expected request payload and renders the run id + outcome", async () => {
    const { fetchImpl, log } = scriptedFetch("completed");
    const lines: string[] = [];
    await runRun(
      { file: entry, org: "acme", token: "t", input: '{"k":"v"}' },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );

    // The trigger POST carries the parsed input wrapped in `{ input }`, to the org/workflow path.
    const trigger = log.find((e) => e.method === "POST" && e.url.endsWith("/runs"));
    expect(trigger).toBeDefined();
    expect(trigger?.url).toBe("https://api.x/v1/orgs/acme/workflows/wf1/runs");
    expect(trigger?.body).toEqual({ input: { k: "v" } });

    const text = lines.join("\n");
    expect(text).toContain("▶ run run1 triggered (triggered)");
    expect(text).toContain("run:     run1");
    expect(text).toContain("status:  completed");
    expect(text).toContain("outcome: success");
    // It wrote the project link so a second run is pinned.
    expect(existsSync(join(dir, ".boardwalk", "project.json"))).toBe(true);
    const link: unknown = JSON.parse(readFileSync(join(dir, ".boardwalk", "project.json"), "utf8"));
    expect(link).toEqual({ orgSlug: "acme", workflowId: "wf1" });
  });

  it("omits the input key (default) when --input is not provided", async () => {
    const { fetchImpl, log } = scriptedFetch("completed");
    await runRun(
      { file: entry, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    const trigger = log.find((e) => e.method === "POST" && e.url.endsWith("/runs"));
    // No `--input` ⇒ empty body, NOT `{ input: undefined }`.
    expect(trigger?.body).toEqual({});
  });

  it("rejects malformed --input JSON with a descriptive error and never triggers a run", async () => {
    const { fetchImpl, log } = scriptedFetch("completed");
    await expect(
      runRun(
        { file: entry, org: "acme", token: "t", input: "{not json" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/--input is not valid JSON/);
    // The run is never dispatched when the input can't be parsed.
    expect(log.some((e) => e.method === "POST" && e.url.endsWith("/runs"))).toBe(false);
  });

  it("fails with a clear error and no run dispatch when no org can be resolved", async () => {
    const { fetchImpl, log } = scriptedFetch("completed");
    await expect(
      runRun({ file: entry, token: "t" }, { config: CONFIG, fetchImpl, log: () => undefined }),
    ).rejects.toThrow(/No org to deploy into/);
    expect(log.some((e) => e.method === "POST" && e.url.endsWith("/runs"))).toBe(false);
  });

  it("maps a 5xx trigger response to a user-facing CliError carrying the status", async () => {
    const { fetchImpl } = scriptedFetch("completed", {
      url: /\/workflows\/wf1\/runs$/,
      status: 500,
      body: JSON.stringify({ error: { message: "engine on fire" } }),
    });
    const err = await runRun(
      { file: entry, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/runs failed \(500\)/);
    expect((err as CliError).hint).toContain("engine on fire");
    expect((err as CliError).status).toBe(500);
  });

  it("surfaces a 403 deploy response as a permission error", async () => {
    const { fetchImpl } = scriptedFetch("completed", {
      url: /\/orgs\/acme\/workflows$/,
      status: 403,
    });
    const err = await runRun(
      { file: entry, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).status).toBe(403);
    expect((err as CliError).hint).toMatch(/Forbidden/);
  });

  it("maps a thrown network error during deploy to a reachability CliError", async () => {
    const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as FetchLike;
    const err = await runRun(
      { file: entry, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toMatch(/Could not reach the Boardwalk API/);
  });

  it("throws (non-zero exit) when the run finishes in a non-completed terminal state", async () => {
    const { fetchImpl } = scriptedFetch("failed");
    const lines: string[] = [];
    await expect(
      runRun(
        { file: entry, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
      ),
    ).rejects.toThrow(/Run failed\./);
    // It still renders the outcome block before raising.
    expect(lines.join("\n")).toContain("status:  failed");
  });

  it("with --no-wait, triggers then returns without polling the run", async () => {
    const { fetchImpl, log } = scriptedFetch("completed");
    const lines: string[] = [];
    await runRun(
      { file: entry, org: "acme", token: "t", noWait: true },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    // No GET /v1/runs/run1 poll happened.
    expect(log.some((e) => e.method === "GET" && e.url.endsWith("/v1/runs/run1"))).toBe(false);
    expect(lines.join("\n")).toContain("--no-wait");
  });
});
