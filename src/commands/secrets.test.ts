// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatSecrets, runSecretsList, runSecretSet, runSecretDelete } from "./secrets.js";
import type { SecretListItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const NOW = 1_700_000_000_000;

function secret(over: Partial<SecretListItem> = {}): SecretListItem {
  return {
    id: "01HSEC0000000000000000000A",
    name: "GITHUB_TOKEN",
    scope: "org",
    kind: "api_key",
    last4: "cdef",
    description: null,
    createdAt: NOW - 3600 * 1000,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

/** Route by method+url: secrets list (GET /secrets), create (POST /secrets), delete (DELETE /secrets/:id). */
function routeFetch(routes: {
  secrets?: unknown[];
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
        new Response(JSON.stringify(routes.createBody ?? { secret: secret() }), {
          status: routes.createStatus ?? 201,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ secrets: routes.secrets ?? [], nextCursor: null })),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatSecrets", () => {
  it("renders names/scope/kind/last4 — and never a value column with raw values", () => {
    const out = formatSecrets("acme", [secret()], NOW).join("\n");
    expect(out).toContain("Secrets · acme  (1)");
    expect(out).toMatch(/NAME\s+SCOPE\s+KIND\s+VALUE\s+CREATED/);
    expect(out).toContain("GITHUB_TOKEN");
    expect(out).toContain("…cdef"); // last4 hint only
  });

  it("reports an empty catalog cleanly", () => {
    expect(formatSecrets("acme", [], NOW)).toEqual([
      "No secrets in acme yet — add one with `boardwalk secrets set <name>`.",
    ]);
  });
});

describe("runSecretsList", () => {
  it("GETs the org secrets and renders the table", async () => {
    const { fetchImpl, calls } = routeFetch({ secrets: [secret()] });
    const lines: string[] = [];
    await runSecretsList(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/secrets");
    expect(lines.join("\n")).toContain("GITHUB_TOKEN");
  });
});

describe("runSecretSet", () => {
  it("creates a secret from --value with default scope/kind", async () => {
    const { fetchImpl, calls } = routeFetch({});
    const lines: string[] = [];
    await runSecretSet(
      { name: "API_KEY", value: "shh", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      name: "API_KEY",
      value: "shh",
      scope: "org",
      kind: "api_key",
    });
    expect(lines.join("\n")).toContain("✓ set secret");
  });

  it("reads the value from stdin (trailing newline stripped) when --value is absent", async () => {
    const { fetchImpl, calls } = routeFetch({});
    await runSecretSet(
      { name: "API_KEY", org: "acme", token: "t" },
      {
        config: CONFIG,
        fetchImpl,
        log: () => undefined,
        readStdin: () => Promise.resolve("piped-value\n"),
      },
    );
    const post = calls.find((c) => c.method === "POST");
    expect(JSON.parse(post?.body ?? "{}").value).toBe("piped-value");
  });

  it("rejects an empty value without a request", async () => {
    const { fetchImpl, calls } = routeFetch({});
    await expect(
      runSecretSet(
        { name: "API_KEY", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, readStdin: () => Promise.resolve("\n") },
      ),
    ).rejects.toThrow(/No secret value/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects an invalid --scope", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runSecretSet(
        { name: "X", value: "v", scope: "global", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/Invalid --scope/);
  });

  it("maps a 403 to an elevated-login hint", async () => {
    const { fetchImpl } = routeFetch({
      createStatus: 403,
      createBody: { error: { message: "no" } },
    });
    await expect(
      runSecretSet(
        { name: "X", value: "v", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toMatchObject({ hint: expect.stringContaining("login --scopes admin") });
  });
});

describe("runSecretDelete", () => {
  it("without --yes, prints the target and does NOT delete", async () => {
    const { fetchImpl, calls } = routeFetch({ secrets: [secret()] });
    const lines: string[] = [];
    await runSecretDelete(
      { name: "GITHUB_TOKEN", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(lines.join("\n")).toMatch(/Re-run with --yes/);
  });

  it("with --yes, resolves the name to an id and DELETEs it", async () => {
    const { fetchImpl, calls } = routeFetch({ secrets: [secret({ id: "01HSEC_TARGET" })] });
    const lines: string[] = [];
    await runSecretDelete(
      { name: "GITHUB_TOKEN", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toContainEqual({
      url: "https://api.x/v1/secrets/01HSEC_TARGET",
      method: "DELETE",
      body: undefined,
    });
    expect(lines.join("\n")).toContain("✓ deleted secret");
  });

  it("errors when the name isn't found", async () => {
    const { fetchImpl } = routeFetch({ secrets: [] });
    await expect(
      runSecretDelete(
        { name: "MISSING", yes: true, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/No secret "MISSING"/);
  });

  it("asks to disambiguate when a name spans scopes", async () => {
    const { fetchImpl } = routeFetch({
      secrets: [secret({ id: "a", scope: "org" }), secret({ id: "b", scope: "user" })],
    });
    await expect(
      runSecretDelete(
        { name: "GITHUB_TOKEN", yes: true, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/matches 2 secrets/);
  });
});
