// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  isTerminalStatus,
  pollToTerminal,
  parseInput,
  collectRunOutputs,
  type RunReader,
} from "./run.js";
import type { RunSummary, RunEventSnapshot } from "../client.js";
import type { RunEvent } from "@boardwalk-labs/workflow";

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
