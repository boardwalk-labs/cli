// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { cancelMessage, runCancel } from "./cancel.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

describe("cancelMessage", () => {
  it("reports a clean cancelled run", () => {
    expect(cancelMessage("cancelled", "run1")).toMatch(/✓ run run1 cancelled/);
  });
  it("explains the async cancelling state", () => {
    const msg = cancelMessage("cancelling", "run1");
    expect(msg).toContain("cancelling");
    expect(msg).toContain("finalize as cancelled");
  });
  it("notes a no-op when the run already finished", () => {
    expect(cancelMessage("completed", "run1")).toMatch(/already finished \(completed\)/);
    expect(cancelMessage("failed", "run1")).toMatch(/already finished \(failed\)/);
  });
  it("falls back to a generic line for any other status", () => {
    expect(cancelMessage("running", "run1")).toMatch(
      /cancel requested for run run1 \(status: running\)/,
    );
  });
});

/** A fetch that answers the cancel POST with 204 and the run GET with `runStatus`. */
function cancelFetch(runStatus: string): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const method = init?.method ?? "GET";
    if (method === "POST") return Promise.resolve(new Response(null, { status: 204 }));
    return Promise.resolve(
      new Response(
        JSON.stringify({
          run: {
            id: "run1",
            workflowId: "wf1",
            status: runStatus,
            outcomeStatus: null,
            startedAt: null,
            completedAt: null,
          },
        }),
        { status: 200 },
      ),
    );
  }) as FetchLike;
  return { fetchImpl, urls };
}

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

describe("runCancel", () => {
  it("cancels then reads the run back and logs the resulting status", async () => {
    const { fetchImpl, urls } = cancelFetch("cancelling");
    const lines: string[] = [];
    await runCancel(
      { runId: "run1", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(urls).toEqual(["https://api.x/v1/runs/run1/cancel", "https://api.x/v1/runs/run1"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("cancelling");
  });

  it("reports a terminal cancelled run", async () => {
    const { fetchImpl } = cancelFetch("cancelled");
    const lines: string[] = [];
    await runCancel(
      { runId: "run1", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(lines[0]).toMatch(/✓ run run1 cancelled/);
  });

  it("rejects an empty run id without making a request", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as FetchLike;
    await expect(
      runCancel({ runId: "  ", token: "t" }, { config: CONFIG, fetchImpl, log: () => undefined }),
    ).rejects.toThrow(/run id is required/);
    expect(called).toBe(false);
  });
});
