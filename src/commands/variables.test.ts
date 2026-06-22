// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatVariables,
  runVariablesList,
  runVariableSet,
  runVariableDelete,
} from "./variables.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const PROD = { id: "env_prod", name: "Production", description: null };
const VAR_PROD = {
  id: "var_1",
  name: "POSTHOG_PROJECT_ID",
  value: "394895",
  environmentId: "env_prod",
};
const VAR_BASE = { id: "var_2", name: "REGION", value: "us-east-1", environmentId: null };

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

/** GET /env-variables → variables; GET /environments → environments; POST → variable; DELETE → 204. */
function routeFetch(routes: {
  variables?: unknown[];
  environments?: unknown[];
  createBody?: unknown;
}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify(routes.createBody ?? { variable: VAR_BASE }), { status: 201 }),
      );
    }
    if (url.includes("/env-variables")) {
      return Promise.resolve(
        new Response(JSON.stringify({ variables: routes.variables ?? [], nextCursor: null })),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ environments: routes.environments ?? [], nextCursor: null })),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatVariables", () => {
  it("shows name / environment / value (values are non-secret)", () => {
    const out = formatVariables("acme", [
      { id: "v", name: "POSTHOG_PROJECT_ID", value: "394895", environment: "Production" },
      { id: "v2", name: "REGION", value: "us-east-1", environment: null },
    ]).join("\n");
    expect(out).toContain("394895");
    expect(out).toContain("Production");
    expect(out).toContain("(base)"); // null environment renders as the base
  });
});

describe("runVariablesList", () => {
  it("joins each variable to its environment name and shows the value", async () => {
    const { fetchImpl } = routeFetch({ variables: [VAR_PROD, VAR_BASE], environments: [PROD] });
    const lines: string[] = [];
    await runVariablesList(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toContain("POSTHOG_PROJECT_ID");
    expect(out).toContain("394895");
    expect(out).toContain("Production");
  });

  it("filters to one environment when --environment is given", async () => {
    const { fetchImpl } = routeFetch({ variables: [VAR_PROD, VAR_BASE], environments: [PROD] });
    const lines: string[] = [];
    await runVariablesList(
      { environment: "Production", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toContain("POSTHOG_PROJECT_ID");
    expect(out).not.toContain("REGION");
  });
});

describe("runVariableSet", () => {
  it("resolves the environment NAME → id and POSTs the value", async () => {
    const { fetchImpl, calls } = routeFetch({
      environments: [PROD],
      createBody: { variable: VAR_PROD },
    });
    const lines: string[] = [];
    await runVariableSet(
      {
        name: "POSTHOG_PROJECT_ID",
        value: "394895",
        environment: "Production",
        org: "acme",
        token: "t",
      },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("/env-variables");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      name: "POSTHOG_PROJECT_ID",
      value: "394895",
      environmentId: "env_prod",
    });
    expect(lines.join("\n")).toContain("✓ set variable POSTHOG_PROJECT_ID in Production");
  });

  it("defaults to the org base (environmentId null) when no --environment", async () => {
    const { fetchImpl, calls } = routeFetch({ environments: [PROD] });
    await runVariableSet(
      { name: "REGION", value: "us-east-1", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({ environmentId: null });
  });

  it("errors on an unknown environment", async () => {
    const { fetchImpl } = routeFetch({ environments: [PROD] });
    await expect(
      runVariableSet(
        { name: "X", value: "1", environment: "Nope", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/No environment "Nope"/);
  });
});

describe("runVariableDelete", () => {
  it("requires --yes (no DELETE)", async () => {
    const { fetchImpl, calls } = routeFetch({ variables: [VAR_BASE], environments: [PROD] });
    const lines: string[] = [];
    await runVariableDelete(
      { name: "REGION", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(lines.join("\n")).toContain("--yes");
  });

  it("resolves (name, environment) → id and DELETEs with --yes", async () => {
    const { fetchImpl, calls } = routeFetch({ variables: [VAR_PROD], environments: [PROD] });
    await runVariableDelete(
      { name: "POSTHOG_PROJECT_ID", environment: "Production", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/env-variables/var_1");
  });
});
