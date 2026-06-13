// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { isTerminalStatus, pollToTerminal, parseInput, type RunReader } from "./run.js";
import type { RunSummary } from "../client.js";

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
