// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  isTerminalStatus,
  pollToTerminal,
  parseInput,
  collectRunOutputs,
  describeVersion,
  runRun,
  type RunReader,
} from "./run.js";
import type { RunSummary, RunEventSnapshot } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";
import type { RunEvent } from "@boardwalk-labs/workflow";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const WF_ID = "01KV0000000000000000000007";
const NOW = 1_700_000_000_000;

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
  it("undefined when absent, parsed when valid, throws when malformed", () => {
    expect(parseInput(undefined)).toBeUndefined();
    expect(parseInput('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseInput("{bad")).toThrow(/not valid JSON/);
  });
});

describe("collectRunOutputs", () => {
  function outputEvent(value: unknown): RunEvent {
    return { kind: "output", value, runId: "r", turnId: "t", seq: 1, t: 0 };
  }
  function phaseEvent(name: string): RunEvent {
    return { kind: "phase", name, id: "p", runId: "r", turnId: "t", seq: 1, t: 0 };
  }

  it("pulls every output(...) value from the event log, formatting non-strings as JSON", async () => {
    const snapshot: RunEventSnapshot = {
      events: [
        { cursor: 1, event: phaseEvent("Research") }, // ignored — not an output frame
        { cursor: 2, event: outputEvent("line one\nline two") },
        { cursor: 3, event: outputEvent({ ok: true }) },
      ],
      done: true,
    };
    const outputs = await collectRunOutputs({ getRunEvents: () => Promise.resolve(snapshot) }, "r");
    expect(outputs).toEqual(["line one\nline two", JSON.stringify({ ok: true }, null, 2)]);
  });

  it("returns [] when the run produced no output", async () => {
    const snapshot: RunEventSnapshot = {
      events: [{ cursor: 1, event: phaseEvent("Research") }],
      done: true,
    };
    const outputs = await collectRunOutputs({ getRunEvents: () => Promise.resolve(snapshot) }, "r");
    expect(outputs).toEqual([]);
  });
});

describe("pollToTerminal", () => {
  function reader(statuses: string[]): { client: RunReader; calls: number } {
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
    return {
      client,
      get calls() {
        return state.calls;
      },
    };
  }

  it("polls until a terminal status and returns the run", async () => {
    const { client } = reader(["pending", "running", "completed"]);
    const seen: string[] = [];
    const result = await pollToTerminal(client, "run1", {
      sleep: () => Promise.resolve(),
      onStatus: (s) => seen.push(s),
    });
    expect(result.status).toBe("completed");
    expect(seen).toEqual(["pending", "running", "completed"]);
  });

  it("times out if the run never reaches a terminal state", async () => {
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

describe("describeVersion", () => {
  const versions = [
    { id: "v2", number: 2, createdAt: NOW - 2 * 3600 * 1000 },
    { id: "v1", number: 1, createdAt: NOW - 5 * 86400 * 1000 },
  ];

  it("names the CURRENT version and how long ago it was deployed", () => {
    expect(describeVersion({ currentVersionId: "v2", versions }, NOW)).toBe(
      "version 2 · deployed 2h ago",
    );
  });

  it("reports the current version even when it isn't the newest row", () => {
    expect(describeVersion({ currentVersionId: "v1", versions }, NOW)).toBe(
      "version 1 · deployed 5d ago",
    );
  });

  it("says so when nothing is deployed", () => {
    expect(describeVersion({ currentVersionId: null, versions: [] }, NOW)).toBe(
      "no deployed version",
    );
  });
});

/** Route every endpoint `run` touches. `orgs` drives the credential's scope (/v1/me). */
function platform(
  opts: {
    orgs?: string[];
    statuses?: string[];
    outputs?: unknown[];
    error?: { code: string; message: string; hint?: string };
  } = {},
): {
  fetchImpl: FetchLike;
  calls: { method: string; url: string; body?: unknown }[];
} {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const statuses = opts.statuses ?? ["completed"];
  let poll = 0;
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, ...(body !== undefined ? { body } : {}) });
    const json = (value: unknown): Promise<Response> =>
      Promise.resolve(new Response(JSON.stringify(value)));

    if (url.endsWith("/v1/me")) {
      return json({
        user: { id: "u1", email: "a@b.c", name: null },
        memberships: (opts.orgs ?? ["acme"]).map((slug) => ({
          orgId: "o1",
          slug,
          role: "owner",
          name: slug,
          plan: null,
        })),
      });
    }
    if (/\/v1\/orgs\/[^/]+\/workflows$/.test(url)) {
      return json({
        workflows: [
          {
            id: WF_ID,
            slug: "nightly-summary",
            title: "Nightly",
            triggerKinds: ["manual"],
            updatedAt: NOW,
            lastRun: null,
            disabled: false,
          },
        ],
      });
    }
    if (/\/v1\/workflows\/[^/]+$/.test(url)) {
      return json({
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: {},
        versions: [{ id: "v2", number: 2, createdAt: NOW - 3600 * 1000 }],
      });
    }
    if (method === "POST" && url.includes("/runs")) {
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
    if (/\/v1\/runs\/[^/]+\/events/.test(url)) {
      return json({
        events: (opts.outputs ?? []).map((value, i) => ({
          cursor: i + 1,
          event: { kind: "output", value, runId: "run1", turnId: "t", seq: i + 1, t: 0 },
        })),
      });
    }
    if (/\/v1\/runs\/[^/]+$/.test(url)) {
      const status = statuses[Math.min(poll, statuses.length - 1)] ?? "completed";
      poll += 1;
      return json({
        run: {
          id: "run1",
          workflowId: WF_ID,
          status,
          outcomeStatus: status === "completed" ? "success" : null,
          startedAt: null,
          completedAt: null,
          ...(status === "failed" && opts.error !== undefined ? { error: opts.error } : {}),
        },
      });
    }
    return json({});
  };
  return { fetchImpl, calls };
}

describe("runRun — a purely control-plane command", () => {
  it("runs a workflow BY SLUG with no local package: resolve → trigger → poll → print output", async () => {
    const { fetchImpl, calls } = platform({ outputs: ["all clear"] });
    const lines: string[] = [];
    await runRun(
      { workflow: "nightly-summary", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    // Nothing was built or deployed — no POST to the artifact/version endpoints.
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/versions"))).toBe(false);
    expect(calls).toContainEqual({
      method: "POST",
      url: `https://api.x/v1/orgs/acme/workflows/${WF_ID}/runs`,
      body: {},
    });
    const out = lines.join("\n");
    expect(out).toContain("nightly-summary · version 2 · deployed 1h ago");
    expect(out).toContain("all clear");
  });

  it("takes a workflow ID directly, skipping the slug lookup", async () => {
    const { fetchImpl, calls } = platform();
    await runRun(
      { workflow: WF_ID, token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    expect(calls.some((c) => c.url.endsWith("/v1/orgs/acme/workflows"))).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/runs"))).toBe(true);
  });

  it("passes --input as the trigger payload and --environment through", async () => {
    const { fetchImpl, calls } = platform();
    await runRun(
      {
        workflow: "nightly-summary",
        input: '{"since":"2026-01-01"}',
        environment: "staging",
        token: "t",
      },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    const trigger = calls.find((c) => c.method === "POST" && c.url.includes("/runs"));
    expect(trigger?.body).toEqual({ input: { since: "2026-01-01" }, environment: "staging" });
  });

  it("--no-wait triggers and exits without polling the run", async () => {
    const { fetchImpl, calls } = platform();
    const lines: string[] = [];
    await runRun(
      { workflow: "nightly-summary", noWait: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith("/v1/runs/run1"))).toBe(false);
    expect(lines.join("\n")).toContain("--no-wait");
  });

  it("fails the command when the run doesn't complete", async () => {
    const { fetchImpl } = platform({ statuses: ["failed"] });
    await expect(
      runRun(
        { workflow: "nightly-summary", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("failed") });
  });

  it("a failed run's error + hint print inline in the result block", async () => {
    const { fetchImpl } = platform({
      statuses: ["failed"],
      error: {
        code: "NOT_FOUND",
        message: 'Secret "X" is not set in this org.',
        hint: "Set it with `boardwalk secrets set X`.",
      },
    });
    const lines: string[] = [];
    await expect(
      runRun(
        { workflow: "nightly-summary", token: "t" },
        { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("failed") });
    const out = lines.join("\n");
    expect(out).toContain('error:   NOT_FOUND: Secret "X" is not set in this org.');
    expect(out).toContain("hint:    Set it with `boardwalk secrets set X`.");
    // The dead outcome column never prints as a "(none)" line readers must puzzle over.
    expect(out).not.toContain("outcome:");
  });

  it("a multi-org login must name the org — it never guesses", async () => {
    const { fetchImpl } = platform({ orgs: ["acme", "other"] });
    await expect(
      runRun(
        { workflow: "nightly-summary", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("No org selected"),
      hint: expect.stringContaining("acme, other"),
    });
  });

  // The whole point of the redesign: running is a control-plane act, so a path is a category error.
  it.each([".", "..", "./my-workflow", "workflows/nightly"])(
    "redirects a path-shaped argument (%s) to deploy",
    async (arg) => {
      const { fetchImpl, calls } = platform();
      await expect(
        runRun({ workflow: arg, token: "t" }, { config: CONFIG, fetchImpl, log: () => undefined }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("not a path"),
        hint: expect.stringContaining("deploy"),
      });
      // It bails before touching the network at all.
      expect(calls).toEqual([]);
    },
  );
});
