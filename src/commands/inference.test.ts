// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatProviders,
  runInferenceList,
  runInferenceAdd,
  runInferenceDelete,
} from "./inference.js";
import type { ProviderListItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

function provider(over: Partial<ProviderListItem> = {}): ProviderListItem {
  return {
    name: "my-openai",
    source: "openai",
    baseUrl: null,
    region: null,
    hasApiKey: true,
    billedByBoardwalk: false,
    createdAt: 1,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function routeFetch(routes: {
  providers?: unknown[];
  createStatus?: number;
  createBody?: unknown;
  deleteStatus?: number;
}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "DELETE") {
      return Promise.resolve(new Response(null, { status: routes.deleteStatus ?? 204 }));
    }
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify(routes.createBody ?? { provider: provider() }), {
          status: routes.createStatus ?? 201,
        }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify({ providers: routes.providers ?? [] })));
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatProviders", () => {
  it("renders name/source/endpoint/key?/billing — never the API key", () => {
    const out = formatProviders("acme", [
      provider({ baseUrl: "https://v", source: "openai_compatible" }),
    ]).join("\n");
    expect(out).toContain("Inference providers · acme  (1)");
    expect(out).toMatch(/NAME\s+SOURCE\s+ENDPOINT\s+KEY\s+BILLING/);
    expect(out).toContain("my-openai");
    expect(out).toContain("https://v");
    expect(out).toContain("byo");
  });

  it("reports an empty list cleanly", () => {
    expect(formatProviders("acme", [])).toEqual([
      "No inference providers in acme — add one with `boardwalk inference add <name>`.",
    ]);
  });
});

describe("runInferenceList", () => {
  it("GETs the org providers and renders the table", async () => {
    const { fetchImpl, calls } = routeFetch({ providers: [provider()] });
    const lines: string[] = [];
    await runInferenceList(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/inference-providers");
    expect(lines.join("\n")).toContain("my-openai");
  });
});

describe("runInferenceAdd", () => {
  it("creates a provider with the source + optional fields + an inline key", async () => {
    const { fetchImpl, calls } = routeFetch({});
    const lines: string[] = [];
    await runInferenceAdd(
      {
        name: "vllm",
        source: "openai_compatible",
        baseUrl: "https://v",
        apiKey: "k",
        org: "acme",
        token: "t",
      },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "vllm",
      source: "openai_compatible",
      baseUrl: "https://v",
      apiKey: "k",
    });
    expect(lines.join("\n")).toContain("✓ added provider");
  });

  it("reads the api key from stdin (trailing newline stripped) when --api-key is absent", async () => {
    const { fetchImpl, calls } = routeFetch({});
    await runInferenceAdd(
      { name: "vllm", source: "openai", org: "acme", token: "t" },
      {
        config: CONFIG,
        fetchImpl,
        log: () => undefined,
        readStdin: () => Promise.resolve("sk-piped\n"),
      },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}").apiKey).toBe("sk-piped");
  });

  it("rejects a missing/invalid --source", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runInferenceAdd(
        { name: "x", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/--source is required/);
    await expect(
      runInferenceAdd(
        { name: "x", source: "nope", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/Invalid --source/);
  });

  it("maps a 403 to an elevated-login hint", async () => {
    const { fetchImpl } = routeFetch({
      createStatus: 403,
      createBody: { error: { message: "no" } },
    });
    await expect(
      runInferenceAdd(
        { name: "vllm", source: "openai", apiKey: "k", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toMatchObject({ hint: expect.stringContaining("login --scopes admin") });
  });
});

describe("runInferenceDelete", () => {
  it("without --yes, prints the target and does NOT delete", async () => {
    const { fetchImpl, calls } = routeFetch({});
    const lines: string[] = [];
    await runInferenceDelete(
      { name: "vllm", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(lines.join("\n")).toMatch(/Re-run with --yes/);
  });

  it("with --yes, DELETEs the provider by name", async () => {
    const { fetchImpl, calls } = routeFetch({});
    const lines: string[] = [];
    await runInferenceDelete(
      { name: "vllm", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toContainEqual({
      url: "https://api.x/v1/orgs/acme/inference-providers/vllm",
      method: "DELETE",
      body: undefined,
    });
    expect(lines.join("\n")).toContain("✓ deleted provider");
  });
});
