// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatWorkflowList,
  formatWorkflowDetail,
  formatWorkflowSource,
  runWorkflowsList,
  runWorkflowShow,
  runWorkflowDelete,
  runWorkflowDisable,
  runWorkflowEnable,
} from "./workflows.js";
import type { WorkflowDetail, WorkflowListItem } from "../client.js";
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
const WF_ID = "01KV0000000000000000000007";

function item(over: Partial<WorkflowListItem> = {}): WorkflowListItem {
  return {
    id: "wf1",
    slug: "nightly-summary",
    title: "Nightly Summary",
    triggerKinds: ["cron", "manual"],
    updatedAt: NOW,
    lastRun: { status: "completed", at: NOW - 2 * 3600 * 1000 },
    disabled: false,
    ...over,
  };
}

function detail(over: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: WF_ID,
    slug: "nightly-summary",
    title: "Nightly Summary",
    description: "Summarize the day.",
    currentVersionId: "v2",
    triggers: ["cron", "manual"],
    secrets: ["GITHUB_TOKEN"],
    entry: "index.mjs",
    source: [{ path: "index.ts", content: "export const meta = { slug: 'nightly-summary' };\n" }],
    versions: [
      { id: "v2", number: 2, createdAt: 20 },
      { id: "v1", number: 1, createdAt: 10 },
    ],
    disabled: false,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
}

/** Route by method+url: workflow detail (GET /v1/workflows/:id), delete (DELETE), and the list. */
function routeFetch(routes: { workflows?: unknown[]; detail?: unknown; deleteStatus?: number }): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "DELETE") {
      return Promise.resolve(new Response(null, { status: routes.deleteStatus ?? 204 }));
    }
    if (/\/v1\/workflows\/[^/]+$/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify(routes.detail ?? {})));
    }
    return Promise.resolve(new Response(JSON.stringify({ workflows: routes.workflows ?? [] })));
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatWorkflowList", () => {
  it("renders a header + a row per workflow with triggers and last run", () => {
    const out = formatWorkflowList("acme", [item()], NOW).join("\n");
    expect(out).toContain("Workflows · acme  (1)");
    expect(out).toMatch(/SLUG\s+TITLE\s+TRIGGERS\s+LAST RUN/);
    expect(out).toContain("nightly-summary");
    expect(out).toContain("cron,manual");
    expect(out).toMatch(/completed · 2h ago/);
  });

  it("shows 'never run' when a workflow has no runs", () => {
    const out = formatWorkflowList("acme", [item({ lastRun: null })], NOW).join("\n");
    expect(out).toContain("never run");
  });

  it("reports an empty org cleanly", () => {
    expect(formatWorkflowList("acme", [], NOW)).toEqual([
      "No workflows in acme yet — create one with `boardwalk deploy`.",
    ]);
  });

  it("shows the active search term in the header and the no-match line", () => {
    const out = formatWorkflowList("acme", [item()], NOW, "night").join("\n");
    expect(out).toContain('Workflows · acme · "night"  (1)');
    expect(formatWorkflowList("acme", [], NOW, "zzz")).toEqual([
      'No workflows in acme match "zzz".',
    ]);
  });

  it("marks a disabled row and leaves enabled rows unmarked", () => {
    const out = formatWorkflowList(
      "acme",
      [item({ slug: "paused-wf", disabled: true }), item({ slug: "live-wf" })],
      NOW,
    );
    const paused = out.find((l) => l.includes("paused-wf"));
    const live = out.find((l) => l.includes("live-wf"));
    expect(paused).toContain("· disabled");
    expect(live).not.toContain("disabled");
  });
});

describe("formatWorkflowDetail", () => {
  it("renders identity, manifest projection, and the version list with a current marker", () => {
    const out = formatWorkflowDetail(detail()).join("\n");
    expect(out).toContain("Workflow nightly-summary");
    expect(out).toMatch(/Id\s+01KV0000000000000000000007/);
    expect(out).toMatch(/Triggers\s+cron, manual/);
    expect(out).toMatch(/Secrets\s+GITHUB_TOKEN/);
    expect(out).toMatch(/Version\s+v2 \(current\)/);
    expect(out).toMatch(/→ v2\s+v2/); // current version marked
  });

  it("omits optional fields and shows — for no secrets", () => {
    const out = formatWorkflowDetail(
      detail({ title: null, description: null, secrets: [], entry: null }),
    ).join("\n");
    expect(out).not.toContain("Title");
    expect(out).not.toContain("Description");
    expect(out).toMatch(/Secrets\s+—/);
  });

  it("shows a Status line only when the workflow is disabled", () => {
    expect(formatWorkflowDetail(detail()).join("\n")).not.toContain("Status");
    expect(formatWorkflowDetail(detail({ disabled: true })).join("\n")).toMatch(
      /Status\s+disabled/,
    );
  });

  it("names the program's source files without dumping their contents", () => {
    const out = formatWorkflowDetail(
      detail({
        source: [
          { path: "index.ts", content: "const secret_looking_code = 1;" },
          { path: "plan.ts", content: "export const X = 1;" },
        ],
      }),
    ).join("\n");
    expect(out).toMatch(/Source\s+index\.ts, plan\.ts/);
    expect(out).not.toContain("secret_looking_code");
  });

  it("omits the Source line when the API inlined nothing", () => {
    expect(formatWorkflowDetail(detail({ source: null })).join("\n")).not.toContain("Source");
  });
});

describe("formatWorkflowSource", () => {
  it("prints a single-file program bare, so it can be redirected straight to a file", () => {
    expect(
      formatWorkflowSource(detail({ source: [{ path: "index.ts", content: "const a = 1;" }] })),
    ).toEqual(["const a = 1;"]);
  });

  it("banners each file of a package so the tree is recoverable", () => {
    const out = formatWorkflowSource(
      detail({
        source: [
          { path: "index.ts", content: "import './plan.js';" },
          { path: "plan.ts", content: "export const X = 1;" },
        ],
      }),
    );
    expect(out).toEqual([
      "// ==> index.ts",
      "import './plan.js';",
      "// ==> plan.ts",
      "export const X = 1;",
    ]);
  });

  it("explains itself when the artifact was too large to inline", () => {
    expect(() => formatWorkflowSource(detail({ source: null }))).toThrow(/No inlined source/);
  });
});

describe("runWorkflowsList", () => {
  it("GETs the org workflows and renders the table", async () => {
    const { fetchImpl, calls } = routeFetch({ workflows: [item()] });
    const lines: string[] = [];
    await runWorkflowsList(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/workflows");
    expect(lines.join("\n")).toContain("nightly-summary");
  });

  it("requires an org", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runWorkflowsList(
        { token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, cwd: "/tmp/boardwalk-no-link-xyz" },
      ),
    ).rejects.toThrow(/No org specified/);
  });

  it("passes --search server-side as ?q= (trimmed + url-encoded) and drops a blank term", async () => {
    const { fetchImpl, calls } = routeFetch({ workflows: [item()] });
    await runWorkflowsList(
      { org: "acme", token: "t", search: "  merge conflicts  " },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    expect(calls[0]?.url).toBe("https://api.x/v1/orgs/acme/workflows?q=merge%20conflicts");

    await runWorkflowsList(
      { org: "acme", token: "t", search: "   " },
      { config: CONFIG, fetchImpl, log: () => undefined, now: NOW },
    );
    expect(calls[1]?.url).toBe("https://api.x/v1/orgs/acme/workflows");
  });
});

describe("runWorkflowShow", () => {
  it("fetches a workflow by id and renders its detail", async () => {
    const { fetchImpl, calls } = routeFetch({
      detail: {
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: { title: "Nightly Summary", triggers: [{ kind: "cron" }] },
        program: { entry: "index.mjs" },
        versions: [{ id: "v2", number: 2, createdAt: 20 }],
      },
    });
    const lines: string[] = [];
    await runWorkflowShow(
      { ref: WF_ID, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toEqual([{ url: `https://api.x/v1/workflows/${WF_ID}`, method: "GET" }]);
    expect(lines.join("\n")).toContain("Workflow nightly-summary");
  });
});

describe("runWorkflowDelete", () => {
  it("without --yes, prints the target and does NOT delete", async () => {
    const { fetchImpl, calls } = routeFetch({
      detail: {
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: {},
        versions: [],
      },
    });
    const lines: string[] = [];
    await runWorkflowDelete(
      { ref: WF_ID, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(lines.join("\n")).toMatch(/Re-run with --yes/);
  });

  it("with --yes, DELETEs the workflow", async () => {
    const { fetchImpl, calls } = routeFetch({
      detail: {
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: {},
        versions: [],
      },
      deleteStatus: 204,
    });
    const lines: string[] = [];
    await runWorkflowDelete(
      { ref: WF_ID, yes: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toContainEqual({ url: `https://api.x/v1/workflows/${WF_ID}`, method: "DELETE" });
    expect(lines.join("\n")).toContain("✓ deleted workflow nightly-summary");
  });
});

describe("runWorkflowDisable", () => {
  it("resolves the workflow then POSTs /disable", async () => {
    const { fetchImpl, calls } = routeFetch({
      detail: {
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: {},
        versions: [],
      },
    });
    const lines: string[] = [];
    await runWorkflowDisable(
      { ref: WF_ID, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toContainEqual({ url: `https://api.x/v1/workflows/${WF_ID}`, method: "GET" });
    expect(calls).toContainEqual({
      url: `https://api.x/v1/workflows/${WF_ID}/disable`,
      method: "POST",
    });
    expect(lines.join("\n")).toContain("✓ disabled workflow nightly-summary");
  });
});

describe("runWorkflowEnable", () => {
  it("resolves the workflow then POSTs /enable", async () => {
    const { fetchImpl, calls } = routeFetch({
      detail: {
        workflow: { id: WF_ID, slug: "nightly-summary", currentVersionId: "v2" },
        manifest: {},
        versions: [],
      },
    });
    const lines: string[] = [];
    await runWorkflowEnable(
      { ref: WF_ID, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toContainEqual({
      url: `https://api.x/v1/workflows/${WF_ID}/enable`,
      method: "POST",
    });
    expect(lines.join("\n")).toContain("✓ enabled workflow nightly-summary");
  });
});
