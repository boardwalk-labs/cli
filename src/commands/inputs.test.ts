// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatInputs, runInputs, runRespond } from "./inputs.js";
import type { HumanInputItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

function gate(over: Partial<HumanInputItem> = {}): HumanInputItem {
  return {
    runId: "run_1",
    key: "approve",
    prompt: "Ship it?",
    input: { kind: "choice", options: ["yes", "no"] },
    assignees: null,
    status: "pending",
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** A fetch that records requests and answers with `body` (200). */
function rec(body: unknown): {
  fetchImpl: FetchLike;
  calls: { url: string; method: string; body: string | undefined }[];
} {
  const calls: { url: string; method: string; body: string | undefined }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatInputs", () => {
  it("renders each gate with its prompt + form hint", () => {
    const lines = formatInputs([gate()], "your org").join("\n");
    expect(lines).toContain("run_1  approve");
    expect(lines).toContain("Ship it?");
    expect(lines).toContain("choice: yes | no");
  });

  it("renders an empty state", () => {
    expect(formatInputs([], "your org")[0]).toContain("No inputs awaiting");
  });
});

describe("runInputs", () => {
  it("lists the org inbox (GET /v1/orgs/:slug/inputs)", async () => {
    const { fetchImpl, calls } = rec({ inputs: [gate()] });
    const out: string[] = [];
    await runInputs(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => out.push(l) },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/inputs");
    expect(out.join("\n")).toContain("approve");
  });

  it("lists one run's pending gates when given a runId", async () => {
    const { fetchImpl, calls } = rec({ inputs: [gate()] });
    await runInputs({ runId: "run_1", token: "t" }, { config: CONFIG, fetchImpl });
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run_1/inputs?status=pending");
  });

  it("emits JSON with --json", async () => {
    const { fetchImpl } = rec({ inputs: [gate()] });
    const out: string[] = [];
    await runInputs(
      { org: "acme", json: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => out.push(l) },
    );
    expect(JSON.parse(out.join("\n"))).toMatchObject({ inputs: [{ key: "approve" }] });
  });
});

describe("runRespond", () => {
  it("POSTs a text/choice value to /v1/runs/:id/inputs/:key", async () => {
    const { fetchImpl, calls } = rec({ input: { status: "resolved" } });
    await runRespond(
      { runId: "run_1", key: "approve", value: "yes", token: "t" },
      { config: CONFIG, fetchImpl },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run_1/inputs/approve");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ value: "yes" });
  });

  it("splits --values into an array for multi-select", async () => {
    const { fetchImpl, calls } = rec({ input: { status: "resolved" } });
    await runRespond(
      { runId: "run_1", key: "pick", values: "a, b ,c", other: "d", token: "t" },
      { config: CONFIG, fetchImpl },
    );
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ values: ["a", "b", "c"], other: "d" });
  });

  it("rejects passing both --value and --values", async () => {
    const { fetchImpl } = rec({});
    await expect(
      runRespond(
        { runId: "run_1", key: "approve", value: "yes", values: "a,b", token: "t" },
        { config: CONFIG, fetchImpl },
      ),
    ).rejects.toThrow(/not both/);
  });

  it("rejects when no answer is given", async () => {
    const { fetchImpl } = rec({});
    await expect(
      runRespond({ runId: "run_1", key: "approve", token: "t" }, { config: CONFIG, fetchImpl }),
    ).rejects.toThrow(/Provide an answer/);
  });
});
