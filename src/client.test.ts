// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { BoardwalkClient, isTerminalStatus } from "./client.js";
import type { FetchLike } from "./auth/pkce.js";

/** A minimal valid v1 `program_output` event (passes the SDK's runEventSchema). */
function outputEvent(text: string, seq: number): Record<string, unknown> {
  return { kind: "program_output", stream: "stdout", text, runId: "r", turnId: "tt", seq, t: seq };
}

/** A minimal valid v1 `run_status` event. */
function statusEvent(status: string, seq: number): Record<string, unknown> {
  return { kind: "run_status", status, runId: "r", turnId: "tt", seq, t: seq };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function recordingFetch(
  status: number,
  body: unknown,
): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    // 204/304 are null-body statuses — constructing a Response with a body for them throws.
    const noBody = status === 204 || status === 304;
    return Promise.resolve(
      new Response(noBody ? null : typeof body === "string" ? body : JSON.stringify(body), {
        status,
      }),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("BoardwalkClient.listWorkflows", () => {
  it("GETs the org workflows and returns well-formed rows", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      workflows: [
        { id: "wf1", slug: "a", currentVersionId: "v1" },
        { id: "wf2", slug: "b", currentVersionId: null },
        { id: "bad" }, // dropped — wrong shape
      ],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = await client.listWorkflows("my-org");
    expect(rows).toEqual([
      { id: "wf1", slug: "a", currentVersionId: "v1" },
      { id: "wf2", slug: "b", currentVersionId: null },
    ]);
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/my-org/workflows");
    expect(calls[0]?.headers.Authorization).toBe("Bearer t");
  });
});

describe("BoardwalkClient.createWorkflow", () => {
  it("POSTs the source with an Idempotency-Key and returns the deploy result", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      workflow: { id: "wf9", slug: "demo", currentVersionId: "v1" },
      version: { id: "v1", number: 1 },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const ref = {
      digest: "a".repeat(64),
      size: 10,
      entry: "index.mjs",
      sdkVersion: "*",
      lockfileDigest: null,
    };
    const res = await client.createWorkflow("my-org", ref);
    expect(res.version.number).toBe(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/my-org/workflows");
    expect(calls[0]?.headers["Idempotency-Key"]).toBeDefined();
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ artifact: ref });
  });
});

describe("BoardwalkClient.updateWorkflow", () => {
  it("PATCHes /v1/workflows/:id", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      workflow: { id: "wf9", slug: "demo", currentVersionId: "v2" },
      version: { id: "v2", number: 2 },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const res = await client.updateWorkflow("wf9", {
      digest: "b".repeat(64),
      size: 5,
      entry: "index.mjs",
      sdkVersion: "*",
      lockfileDigest: null,
    });
    expect(res.version.number).toBe(2);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toBe("https://api.x/v1/workflows/wf9");
  });
});

describe("BoardwalkClient.triggerRun", () => {
  it("POSTs the input to the workflow's runs endpoint and returns the run", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      run: {
        id: "run1",
        workflowId: "wf9",
        status: "pending",
        outcomeStatus: null,
        startedAt: null,
        completedAt: null,
      },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const run = await client.triggerRun("my-org", "wf9", { n: 1 });
    expect(run.id).toBe("run1");
    expect(run.status).toBe("pending");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/my-org/workflows/wf9/runs");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ input: { n: 1 } });
  });

  it("sends an empty body when input is undefined", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      run: {
        id: "r",
        workflowId: "w",
        status: "pending",
        outcomeStatus: null,
        startedAt: null,
        completedAt: null,
      },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await client.triggerRun("o", "w", undefined);
    expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({});
  });
});

describe("BoardwalkClient.getRun", () => {
  it("GETs /v1/runs/:id and returns the run", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      run: {
        id: "run1",
        workflowId: "wf9",
        status: "completed",
        outcomeStatus: "success",
        startedAt: 1,
        completedAt: 2,
      },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const run = await client.getRun("run1");
    expect(run.status).toBe("completed");
    expect(run.outcomeStatus).toBe("success");
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run1");
  });
});

describe("BoardwalkClient.cancelRun", () => {
  it("POSTs /v1/runs/:id/cancel with an Idempotency-Key and resolves on 204", async () => {
    const { fetchImpl, calls } = recordingFetch(204, "");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.cancelRun("run1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run1/cancel");
    expect(calls[0]?.headers["Idempotency-Key"]).toBeDefined();
    expect(calls[0]?.body).toBeUndefined();
  });

  it("encodes the run id into the path", async () => {
    const { fetchImpl, calls } = recordingFetch(204, "");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await client.cancelRun("run/with space");
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run%2Fwith%20space/cancel");
  });

  it("surfaces a 404 as an actionable CliError", async () => {
    const { fetchImpl } = recordingFetch(404, { error: { message: "Run run1 not found" } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.cancelRun("run1")).rejects.toMatchObject({
      hint: "Run run1 not found",
    });
  });
});

describe("BoardwalkClient.disableWorkflow / enableWorkflow", () => {
  it("POSTs /v1/workflows/:id/disable with an Idempotency-Key", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { workflow: { id: "wf9", disabledAt: 1 } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.disableWorkflow("wf9")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/workflows/wf9/disable");
    expect(calls[0]?.headers["Idempotency-Key"]).toBeDefined();
  });

  it("POSTs /v1/workflows/:id/enable and encodes the id", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { workflow: { id: "wf9", disabledAt: null } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await client.enableWorkflow("wf/9");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/workflows/wf%2F9/enable");
  });
});

describe("BoardwalkClient.mintInferenceKey", () => {
  it("POSTs /v1/orgs/:slug/inference-keys (no body) and returns token + expiry + id", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      token: "bwk_inf",
      apiKey: { id: "01H_k", expiresAt: 1_900_000_000_000, scopes: ["inference:invoke"] },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const minted = await client.mintInferenceKey("my-org");
    expect(minted).toEqual({ token: "bwk_inf", expiresAt: 1_900_000_000_000, id: "01H_k" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/my-org/inference-keys");
    expect(calls[0]?.body).toBeUndefined();
  });

  it("tolerates a missing apiKey.expiresAt/id (null) but requires the token", async () => {
    const { fetchImpl } = recordingFetch(201, { token: "bwk_inf", apiKey: {} });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    expect(await client.mintInferenceKey("o")).toEqual({
      token: "bwk_inf",
      expiresAt: null,
      id: null,
    });
  });

  it("throws on a response missing the token", async () => {
    const { fetchImpl } = recordingFetch(201, { apiKey: { id: "x" } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.mintInferenceKey("o")).rejects.toBeDefined();
  });
});

describe("isTerminalStatus", () => {
  it("is true only for completed/failed/cancelled", () => {
    expect(["completed", "failed", "cancelled"].every(isTerminalStatus)).toBe(true);
    expect(["queued", "pending", "running", "cancelling"].some(isTerminalStatus)).toBe(false);
  });
});

describe("BoardwalkClient.getRunEvents", () => {
  it("GETs the events snapshot, validates events, and reports done", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      events: [
        { cursor: 1, event: outputEvent("hello", 1) },
        { cursor: 2, event: statusEvent("completed", 2) },
        { cursor: 3, event: { kind: "bogus" } }, // dropped — not a valid RunEvent
      ],
      done: true,
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const snap = await client.getRunEvents("run1");
    expect(snap.done).toBe(true);
    expect(snap.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(snap.events[0]?.event.kind).toBe("program_output");
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run1/events");
  });

  it("passes ?since=<cursor> when given", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { events: [], done: false });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await client.getRunEvents("run1", 7);
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run1/events?since=7");
  });
});

describe("BoardwalkClient.streamRunEvents", () => {
  /** A fetch that returns an SSE body for the stream path; records the request. */
  function sseFetch(sse: string): { fetchImpl: FetchLike; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? "GET", headers, body: undefined });
      return Promise.resolve(
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }) as FetchLike;
    return { fetchImpl, calls };
  }

  it("yields enveloped events parsed from SSE frames, with the cursor from the id", async () => {
    const sse =
      `retry: 1000\n\n` +
      `id: 1\nevent: program_output\ndata: ${JSON.stringify(outputEvent("hi", 1))}\n\n` +
      `id: 2\nevent: run_status\ndata: ${JSON.stringify(statusEvent("completed", 2))}\n\n`;
    const { fetchImpl, calls } = sseFetch(sse);
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = [];
    for await (const row of client.streamRunEvents("run1")) rows.push(row);
    expect(rows.map((r) => r.cursor)).toEqual([1, 2]);
    expect(rows[1]?.event.kind).toBe("run_status");
    expect(calls[0]?.url).toBe("https://api.x/v1/runs/run1/stream");
    expect(calls[0]?.headers.Accept).toBe("text/event-stream");
  });

  it("sends Last-Event-ID when resuming from a cursor", async () => {
    const { fetchImpl, calls } = sseFetch("");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    for await (const _ of client.streamRunEvents("run1", { fromCursor: 12 })) void _;
    expect(calls[0]?.headers["Last-Event-ID"]).toBe("12");
  });

  it("throws on a stream_error frame", async () => {
    const { fetchImpl } = sseFetch(
      `event: stream_error\ndata: ${JSON.stringify({ message: "boom" })}\n\n`,
    );
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(async () => {
      for await (const _ of client.streamRunEvents("run1")) void _;
    }).rejects.toMatchObject({ hint: "boom" });
  });
});

describe("BoardwalkClient.listWorkflowSummaries", () => {
  it("GETs the org workflows with the projection fields", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      workflows: [
        {
          id: "wf1",
          slug: "nightly",
          title: "Nightly",
          triggerKinds: ["cron"],
          updatedAt: 5,
          lastRun: { status: "completed", at: 3 },
        },
        { id: "wf2" }, // dropped — no slug
      ],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = await client.listWorkflowSummaries("my-org");
    expect(rows).toEqual([
      {
        id: "wf1",
        slug: "nightly",
        title: "Nightly",
        triggerKinds: ["cron"],
        updatedAt: 5,
        lastRun: { status: "completed", at: 3 },
        disabled: false,
      },
    ]);
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/my-org/workflows");
  });

  it("reports disabled=true when the row carries a disabledAt timestamp", async () => {
    const { fetchImpl } = recordingFetch(200, {
      workflows: [{ id: "wf1", slug: "paused", disabledAt: 1700 }],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = await client.listWorkflowSummaries("my-org");
    expect(rows[0]?.disabled).toBe(true);
  });
});

describe("BoardwalkClient.getWorkflowDetail", () => {
  it("reads the manifest projection + versions from the detail envelope", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      workflow: { id: "wf1", slug: "nightly", currentVersionId: "v2" },
      manifest: {
        title: "Nightly",
        description: "runs nightly",
        triggers: [{ kind: "cron" }, { kind: "manual" }],
        permissions: { secrets: [{ name: "GITHUB_TOKEN" }] },
      },
      program: { entry: "index.mjs" },
      versions: [
        { id: "v2", number: 2, createdAt: 20 },
        { id: "v1", number: 1, createdAt: 10 },
      ],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const detail = await client.getWorkflowDetail("wf1");
    expect(detail).toEqual({
      id: "wf1",
      slug: "nightly",
      title: "Nightly",
      description: "runs nightly",
      currentVersionId: "v2",
      triggers: ["cron", "manual"],
      secrets: ["GITHUB_TOKEN"],
      entry: "index.mjs",
      versions: [
        { id: "v2", number: 2, createdAt: 20 },
        { id: "v1", number: 1, createdAt: 10 },
      ],
      disabled: false,
    });
    expect(calls[0]?.url).toBe("https://api.x/v1/workflows/wf1");
  });

  it("reports disabled=true when the workflow carries a disabledAt timestamp", async () => {
    const { fetchImpl } = recordingFetch(200, {
      workflow: { id: "wf1", slug: "paused", currentVersionId: "v1", disabledAt: 1700 },
      manifest: {},
      versions: [],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    expect((await client.getWorkflowDetail("wf1")).disabled).toBe(true);
  });

  it("throws on a response missing the workflow envelope", async () => {
    const { fetchImpl } = recordingFetch(200, { manifest: {} });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.getWorkflowDetail("wf1")).rejects.toBeDefined();
  });
});

describe("BoardwalkClient.deleteWorkflow", () => {
  it("DELETEs /v1/workflows/:id and resolves on 204", async () => {
    const { fetchImpl, calls } = recordingFetch(204, "");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.deleteWorkflow("wf1")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.x/v1/workflows/wf1");
    expect(calls[0]?.headers["Idempotency-Key"]).toBeDefined();
  });

  it("surfaces a 403 (missing scope) as an actionable CliError", async () => {
    const { fetchImpl } = recordingFetch(403, { error: { message: "forbidden" } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.deleteWorkflow("wf1")).rejects.toMatchObject({
      hint: expect.stringContaining("permission"),
    });
  });
});

describe("BoardwalkClient.listWorkflowRuns", () => {
  it("GETs the per-workflow runs endpoint with filters", async () => {
    const { fetchImpl, calls } = recordingFetch(200, { runs: [], nextCursor: null });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await client.listWorkflowRuns("my-org", "wf1", { status: "failed", limit: 5 });
    expect(calls[0]?.url).toBe(
      "https://api.x/v1/orgs/my-org/workflows/wf1/runs?status=failed&limit=5",
    );
  });
});

describe("BoardwalkClient secrets", () => {
  it("lists secrets (metadata only) and drops malformed rows", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      secrets: [
        {
          id: "s1",
          name: "GITHUB_TOKEN",
          scope: "org",
          kind: "api_key",
          last4: "cdef",
          createdAt: 1,
        },
        { name: "nope" }, // dropped — no id
      ],
      nextCursor: null,
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = await client.listSecrets("acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "s1", name: "GITHUB_TOKEN", last4: "cdef" });
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/secrets");
  });

  it("creates a secret (value in the body, metadata back)", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      secret: {
        id: "s9",
        name: "API_KEY",
        scope: "org",
        kind: "api_key",
        last4: "wxyz",
        createdAt: 2,
      },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const row = await client.createSecret("acme", {
      name: "API_KEY",
      value: "super-secret",
      scope: "org",
      kind: "api_key",
    });
    expect(row.last4).toBe("wxyz");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/secrets");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      name: "API_KEY",
      value: "super-secret",
      scope: "org",
      kind: "api_key",
    });
  });

  it("deletes a secret by id", async () => {
    const { fetchImpl, calls } = recordingFetch(204, "");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.deleteSecret("s9")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.x/v1/secrets/s9");
  });
});

describe("BoardwalkClient inference providers", () => {
  it("lists providers (endpoint metadata only)", async () => {
    const { fetchImpl, calls } = recordingFetch(200, {
      providers: [
        {
          name: "my-openai",
          source: "openai",
          baseUrl: null,
          hasApiKey: true,
          billedByBoardwalk: false,
          createdAt: 1,
        },
        { source: "openai" }, // dropped — no name
      ],
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const rows = await client.listProviders("acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "my-openai", source: "openai", hasApiKey: true });
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/inference-providers");
  });

  it("creates a provider (apiKey in the body, metadata back)", async () => {
    const { fetchImpl, calls } = recordingFetch(201, {
      provider: {
        name: "vllm",
        source: "openai_compatible",
        baseUrl: "https://v",
        hasApiKey: true,
        billedByBoardwalk: false,
        createdAt: 2,
      },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    const row = await client.createProvider("acme", {
      name: "vllm",
      source: "openai_compatible",
      baseUrl: "https://v",
      apiKey: "k",
    });
    expect(row.name).toBe("vllm");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/inference-providers");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
      name: "vllm",
      source: "openai_compatible",
      baseUrl: "https://v",
      apiKey: "k",
    });
  });

  it("deletes a provider by name", async () => {
    const { fetchImpl, calls } = recordingFetch(204, "");
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.deleteProvider("acme", "vllm")).resolves.toBeUndefined();
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/inference-providers/vllm");
  });
});

describe("BoardwalkClient error mapping", () => {
  it("maps 401 to an actionable message", async () => {
    const { fetchImpl } = recordingFetch(401, { error: { message: "nope" } });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(client.listWorkflows("o")).rejects.toMatchObject({
      hint: expect.stringContaining("boardwalk login"),
    });
  });

  it("surfaces the backend error.message for a 4xx", async () => {
    const { fetchImpl } = recordingFetch(422, {
      error: { code: "VALIDATION_FAILED", message: "bad meta" },
    });
    const client = new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl });
    await expect(
      client.createWorkflow("o", {
        digest: "c".repeat(64),
        size: 1,
        entry: "index.mjs",
        sdkVersion: "*",
        lockfileDigest: null,
      }),
    ).rejects.toMatchObject({ hint: "bad meta" });
  });
});
