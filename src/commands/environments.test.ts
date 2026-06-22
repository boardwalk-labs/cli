// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatEnvironments,
  runEnvironmentsList,
  runEnvironmentCreate,
  runEnvironmentDelete,
} from "./environments.js";
import type { EnvironmentItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

function env(over: Partial<EnvironmentItem> = {}): EnvironmentItem {
  return { id: "01HENV0000000000000000000A", name: "Production", description: null, ...over };
}

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function routeFetch(routes: {
  environments?: unknown[];
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
        new Response(
          JSON.stringify(routes.createBody ?? { environment: env({ name: "Staging" }) }),
          {
            status: 201,
          },
        ),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ environments: routes.environments ?? [], nextCursor: null })),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatEnvironments", () => {
  it("renders names + descriptions", () => {
    const out = formatEnvironments("acme", [env({ description: "prod" })]).join("\n");
    expect(out).toContain("Environments · acme  (1)");
    expect(out).toContain("Production");
    expect(out).toContain("prod");
  });
  it("nudges when empty", () => {
    expect(formatEnvironments("acme", []).join("\n")).toContain("No environments in acme");
  });
});

describe("runEnvironmentsList", () => {
  it("lists the org's environments", async () => {
    const { fetchImpl } = routeFetch({ environments: [env()] });
    const lines: string[] = [];
    await runEnvironmentsList(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(lines.join("\n")).toContain("Production");
  });
});

describe("runEnvironmentCreate", () => {
  it("POSTs the new environment name", async () => {
    const { fetchImpl, calls } = routeFetch({});
    const lines: string[] = [];
    await runEnvironmentCreate(
      { name: "Staging", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/environments");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ name: "Staging" });
    expect(lines.join("\n")).toContain("✓ created environment Staging");
  });
});

describe("runEnvironmentDelete", () => {
  it("requires --yes (prints the target, no DELETE)", async () => {
    const { fetchImpl, calls } = routeFetch({ environments: [env()] });
    const lines: string[] = [];
    await runEnvironmentDelete(
      { name: "Production", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(lines.join("\n")).toContain("--yes");
  });

  it("resolves the name → id and DELETEs with --yes", async () => {
    const { fetchImpl, calls } = routeFetch({ environments: [env()] });
    await runEnvironmentDelete(
      { name: "Production", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/environments/01HENV0000000000000000000A");
  });

  it("errors on an unknown environment", async () => {
    const { fetchImpl } = routeFetch({ environments: [env()] });
    await expect(
      runEnvironmentDelete(
        { name: "Nope", yes: true, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/No environment "Nope"/);
  });
});
