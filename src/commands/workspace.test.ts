// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatWorkspaces,
  formatBytes,
  formatAge,
  runWorkspaceShow,
  runWorkspaceReset,
} from "./workspace.js";
import type { WorkspaceScopeItem } from "../client.js";
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

function scope(over: Partial<WorkspaceScopeItem> = {}): WorkspaceScopeItem {
  return {
    environmentId: null,
    environmentName: null,
    bytes: 4096,
    updatedAt: NOW,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
}

/** Routes the three calls these commands make: workflows list, workspaces list, environments list. */
function routeFetch(
  routes: {
    workspaces?: WorkspaceScopeItem[];
    environments?: { id: string; name: string; description: null }[];
    workflows?: { id: string; slug: string; currentVersionId: string | null }[];
  } = {},
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    if (url.includes("/workspaces")) {
      return Promise.resolve(JsonResponse({ workspaces: routes.workspaces ?? [] }));
    }
    if (url.includes("/environments")) {
      return Promise.resolve(
        JsonResponse({ environments: routes.environments ?? [], nextCursor: null }),
      );
    }
    return Promise.resolve(
      JsonResponse({
        workflows: routes.workflows ?? [{ id: "01H_wf", slug: "triager", currentVersionId: null }],
        nextCursor: null,
      }),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

function JsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("formatBytes", () => {
  it("uses binary units, because that's what a tarball's size means", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(4096)).toBe("4.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 GB");
  });
});

describe("formatAge", () => {
  it("answers 'is this stale?', not the exact timestamp", () => {
    expect(formatAge(NOW, NOW)).toBe("just now");
    expect(formatAge(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAge(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
  });
});

describe("formatWorkspaces", () => {
  it("names each scope by its environment, and the base scope as (base)", () => {
    const out = formatWorkspaces("triager", [
      scope({ environmentId: "01H_env", environmentName: "production", bytes: 5_242_880 }),
      scope(),
    ]).join("\n");
    expect(out).toContain("production");
    expect(out).toContain("5.0 MB");
    expect(out).toContain("(base)");
  });

  it("explains WHY there's nothing when a workflow has never persisted", () => {
    // "No workspace" is the normal state, not an error — so say what would create one.
    const out = formatWorkspaces("triager", []).join("\n");
    expect(out).toContain("no persistent workspace yet");
    expect(out).toContain("workspace: { persist:");
    expect(out).toContain("memory");
  });
});

describe("runWorkspaceShow", () => {
  it("reports what the workflow is storing", async () => {
    const { fetchImpl } = routeFetch({
      workspaces: [scope({ environmentName: "production", environmentId: "01H_env" })],
    });
    const lines: string[] = [];
    await runWorkspaceShow(
      { workflow: "triager", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(lines.join("\n")).toContain("production");
  });

  it("resolves the workflow by SLUG (what a user types)", async () => {
    const { fetchImpl, calls } = routeFetch({ workspaces: [scope()] });
    await runWorkspaceShow(
      { workflow: "triager", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    expect(calls.some((c) => c.url.includes("/v1/workflows/01H_wf/workspaces"))).toBe(true);
  });

  it("errors clearly on an unknown workflow", async () => {
    const { fetchImpl } = routeFetch({ workflows: [] });
    await expect(
      runWorkspaceShow(
        { workflow: "nope", org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/No workflow "nope"/);
  });
});

describe("runWorkspaceReset", () => {
  it("without --yes, shows WHAT would be lost and deletes nothing", async () => {
    // A size is the difference between "that's the cache, fine" and "that's four months of agent
    // memory" — the confirm has to say which, before the deletion, not after.
    const { fetchImpl, calls } = routeFetch({ workspaces: [scope({ bytes: 5_242_880 })] });
    const lines: string[] = [];
    await runWorkspaceReset(
      { workflow: "triager", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toContain("About to reset");
    expect(out).toContain("5.0 MB");
    expect(out).toContain("--yes");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("with --yes, resets the base scope", async () => {
    const { fetchImpl, calls } = routeFetch({ workspaces: [scope()] });
    const lines: string[] = [];
    await runWorkspaceReset(
      { workflow: "triager", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const del = calls.find((c) => c.method === "DELETE");
    expect(del?.url).toContain("/v1/workflows/01H_wf/workspaces");
    expect(del?.url).not.toContain("/workspaces/"); // base scope = the collection, no env segment
    expect(lines.join("\n")).toContain("✓ reset");
  });

  it("with --environment, resets ONLY that environment's scope", async () => {
    const { fetchImpl, calls } = routeFetch({
      workspaces: [scope({ environmentId: "01H_env", environmentName: "production" })],
      environments: [{ id: "01H_env", name: "production", description: null }],
    });
    await runWorkspaceReset(
      { workflow: "triager", environment: "production", yes: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    expect(calls.find((c) => c.method === "DELETE")?.url).toContain(
      "/v1/workflows/01H_wf/workspaces/01H_env",
    );
  });

  it("says so plainly when there's nothing persisted, rather than 'confirming' a no-op", async () => {
    const { fetchImpl, calls } = routeFetch({ workspaces: [] });
    const lines: string[] = [];
    await runWorkspaceReset(
      { workflow: "triager", org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(lines.join("\n")).toContain("nothing to reset");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("errors on an unknown environment instead of resetting the base scope", async () => {
    // Without the name check, a typo'd --environment would silently fall through to `null` and
    // clear the WRONG scope — the one the user didn't name.
    const { fetchImpl } = routeFetch({ workspaces: [scope()], environments: [] });
    await expect(
      runWorkspaceReset(
        { workflow: "triager", environment: "typo", yes: true, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/No environment "typo"/);
  });
});
