// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { BoardwalkClient } from "./client.js";
import type { FetchLike } from "./auth/pkce.js";

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
