// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { looksLikeWorkflowId, resolveWorkflowId } from "./workflow_ref.js";
import { BoardwalkClient } from "./client.js";
import type { FetchLike } from "./auth/pkce.js";

describe("looksLikeWorkflowId", () => {
  it("accepts a 26-char ULID", () => {
    expect(looksLikeWorkflowId("01KV4SMQ0JFCNH9X4VQVW10STZ")).toBe(true);
  });

  it("rejects a slug", () => {
    expect(looksLikeWorkflowId("cli-test-coverage-pr")).toBe(false);
    expect(looksLikeWorkflowId("nightly")).toBe(false);
  });

  it("rejects a too-short or too-long token", () => {
    expect(looksLikeWorkflowId("01KV4SMQ")).toBe(false);
    expect(looksLikeWorkflowId("01KV4SMQ0JFCNH9X4VQVW10STZEXTRA")).toBe(false);
  });
});

/** A client whose workflow-list GET returns `workflows`, recording the URLs it hit. */
function listFetch(workflows: unknown[]): { client: BoardwalkClient; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(new Response(JSON.stringify({ workflows }), { status: 200 }));
  }) as FetchLike;
  return { client: new BoardwalkClient({ baseUrl: "https://api.x", token: "t", fetchImpl }), urls };
}

describe("resolveWorkflowId", () => {
  it("passes a ULID straight through without a lookup", async () => {
    const { client, urls } = listFetch([]);
    const id = await resolveWorkflowId(client, "acme", "01KV4SMQ0JFCNH9X4VQVW10STZ");
    expect(id).toBe("01KV4SMQ0JFCNH9X4VQVW10STZ");
    expect(urls).toEqual([]); // no network for an id
  });

  it("resolves a slug against the org's workflow list", async () => {
    const { client, urls } = listFetch([
      { id: "01KV0000000000000000000001", slug: "other" },
      { id: "01KV0000000000000000000002", slug: "nightly" },
    ]);
    const id = await resolveWorkflowId(client, "acme", "nightly");
    expect(id).toBe("01KV0000000000000000000002");
    expect(urls).toEqual(["https://api.x/v1/orgs/acme/workflows"]);
  });

  it("errors (no network) for a slug with no org", async () => {
    const { client, urls } = listFetch([]);
    await expect(resolveWorkflowId(client, undefined, "nightly")).rejects.toThrow(/Need an org/);
    expect(urls).toEqual([]);
  });

  it("errors when the slug isn't found in the org", async () => {
    const { client } = listFetch([{ id: "01KV0000000000000000000001", slug: "other" }]);
    await expect(resolveWorkflowId(client, "acme", "missing")).rejects.toThrow(
      /No workflow "missing"/,
    );
  });
});
