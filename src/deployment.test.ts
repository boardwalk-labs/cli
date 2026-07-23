// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowDescriptor } from "@boardwalk-labs/workflow";
import { CliError } from "./errors.js";
import {
  deployWithLink,
  fetchCredentialOrgs,
  loadProgram,
  planDeploy,
  resolveDeployOrg,
  type PreparedProgram,
} from "./deployment.js";
import { readLink, writeLink } from "./project.js";
import type { BuiltArtifact } from "./artifact.js";
import type {
  BoardwalkClient,
  WorkflowSummary,
  DeployResult,
  DeployArtifactRef,
  MeResult,
} from "./client.js";

function wf(id: string, name: string): WorkflowSummary {
  return { id, slug: name, currentVersionId: "v1" };
}

function me(...slugs: string[]): MeResult {
  return {
    user: { id: "u1", email: "u@x.test", name: null },
    memberships: slugs.map((slug) => ({
      orgId: `org_${slug}`,
      slug,
      role: "admin",
      name: slug,
      plan: null,
    })),
  };
}

describe("planDeploy", () => {
  it("plans a create when no workflow matches the name", () => {
    expect(planDeploy([wf("wf1", "other")], "new-one")).toEqual({
      action: "create",
      slug: "new-one",
    });
  });

  it("plans an update (with the id) when a workflow matches by name", () => {
    expect(planDeploy([wf("wf1", "a"), wf("wf2", "target")], "target")).toEqual({
      action: "update",
      slug: "target",
      workflowId: "wf2",
    });
  });
});

describe("resolveDeployOrg (Decision 11 — deterministic, never a guess)", () => {
  it("--org wins", () => {
    expect(
      resolveDeployOrg({ orgFlag: "acme", credentialOrgs: ["acme", "beta"], linkOrg: "beta" }),
    ).toBe("acme");
  });

  it("--org must match a single-org credential's scope", () => {
    expect(() =>
      resolveDeployOrg({ orgFlag: "other", credentialOrgs: ["acme"], linkOrg: null }),
    ).toThrow(/doesn't match/);
  });

  it("--org outside a multi-org credential's known scope errors, listing the orgs", () => {
    let caught: unknown;
    try {
      resolveDeployOrg({ orgFlag: "nope", credentialOrgs: ["acme", "beta"], linkOrg: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ hint: expect.stringContaining("acme, beta") });
  });

  it("--org is accepted as-is when the credential scope is unknown", () => {
    expect(resolveDeployOrg({ orgFlag: "acme", credentialOrgs: null, linkOrg: null })).toBe("acme");
  });

  it("a single-org credential is unambiguous — no flag needed", () => {
    expect(resolveDeployOrg({ credentialOrgs: ["solo"], linkOrg: null })).toBe("solo");
  });

  it("the single-org scope outranks a (stale) link", () => {
    expect(resolveDeployOrg({ credentialOrgs: ["solo"], linkOrg: "elsewhere" })).toBe("solo");
  });

  it("multi-org falls back to the active-org context (the project link)", () => {
    expect(resolveDeployOrg({ credentialOrgs: ["acme", "beta"], linkOrg: "beta" })).toBe("beta");
  });

  it("an out-of-scope link is not trusted", () => {
    expect(() => resolveDeployOrg({ credentialOrgs: ["acme", "beta"], linkOrg: "gone" })).toThrow(
      /No org selected/,
    );
  });

  it("multi-org with no selection HARD-ERRORS listing the orgs — never guesses", () => {
    let caught: unknown;
    try {
      resolveDeployOrg({ credentialOrgs: ["acme", "beta"], linkOrg: null });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect(caught).toMatchObject({
      message: "No org selected.",
      hint: expect.stringContaining("acme, beta"),
    });
  });

  it("unknown scope + no flag + no link errors asking for --org", () => {
    expect(() => resolveDeployOrg({ credentialOrgs: null, linkOrg: null })).toThrow(
      /No org selected/,
    );
  });
});

describe("fetchCredentialOrgs", () => {
  it("returns the membership slugs, deduped, nulls dropped", async () => {
    const result = me("acme", "beta");
    result.memberships.push({ orgId: null, slug: null, role: "viewer", name: null, plan: null });
    const client = { getMe: () => Promise.resolve(result) } as unknown as BoardwalkClient;
    expect(await fetchCredentialOrgs(client)).toEqual(["acme", "beta"]);
  });

  it("returns null (scope unknown) when /v1/me is unavailable — never a guess input", async () => {
    const client = {
      getMe: () => Promise.reject(new CliError("nope", undefined, 404)),
    } as unknown as BoardwalkClient;
    expect(await fetchCredentialOrgs(client)).toBeNull();
  });
});

describe("loadProgram", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-load-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the package and takes the slug from the descriptor", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "workflow.jsonc"),
      `{ "slug": "pkg", "triggers": [{ "kind": "manual" }] }`,
    );
    writeFileSync(join(dir, "src", "index.ts"), `export default async function run() {}`);
    mkdirSync(join(dir, "skills"));
    writeFileSync(join(dir, "skills", "s.md"), "# skill");

    const prog = await loadProgram(dir, { typesHarvest: false });
    expect(prog.slug).toBe("pkg");
    expect(prog.entry).toBe("index.mjs");
    expect(prog.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prog.artifact.assetPaths).toEqual(["skills/s.md"]);
  });
});

describe("deployWithLink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-deploy-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fakeClient(over: Partial<BoardwalkClient>): BoardwalkClient {
    return {
      getMe: () => Promise.resolve(me("org")),
      listWorkflows: () => Promise.resolve([]),
      getArtifactUploadUrl: () =>
        Promise.resolve({ uploadUrl: "https://storage/put?sig", contentType: "application/gzip" }),
      uploadArtifact: () => Promise.resolve(),
      createWorkflow: () =>
        Promise.resolve({
          workflow: wf("new", "n"),
          version: { id: "v1", number: 1 },
          warnings: [],
        }),
      updateWorkflow: () =>
        Promise.resolve({
          workflow: wf("ex", "n"),
          version: { id: "v2", number: 2 },
          warnings: [],
        }),
      ...over,
    } as unknown as BoardwalkClient;
  }

  const artifact: BuiltArtifact = {
    tarball: new Uint8Array([1, 2, 3]),
    digest: "a".repeat(64),
    size: 3,
    language: "typescript",
    entry: "index.mjs",
    slug: "n",
    descriptorFileName: "workflow.jsonc",
    descriptor: parseWorkflowDescriptor(`{ "slug": "n", "triggers": [{ "kind": "manual" }] }`),
    sdkVersion: "*",
    lockfileDigest: null,
    assetPaths: [],
    machinePaths: [],
    machineBytes: 0,
  };
  const prog: PreparedProgram = { slug: "n", entry: "index.mjs", artifact };
  const REF: DeployArtifactRef = {
    digest: "a".repeat(64),
    size: 3,
    entry: "index.mjs",
    sdkVersion: "*",
    lockfileDigest: null,
  };

  it("uploads the artifact, then creates + writes the link when unlinked with no name match", async () => {
    const upload = vi.fn(() => Promise.resolve());
    const create = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("new", "n"),
          version: { id: "v1", number: 1 },
          warnings: ["field `when` degraded to raw JSON"],
        }),
    );
    const client = fakeClient({
      listWorkflows: () => Promise.resolve([]),
      uploadArtifact: upload,
      createWorkflow: create,
    });
    const res = await deployWithLink(client, { orgSlug: "org", target: dir, prog });
    expect(res.outcome).toBe("created");
    expect(res.workflowId).toBe("new");
    // The descriptor's slug matches the deployed workflow → reports it, no mismatch warning.
    expect(res.deployedSlug).toBe("n");
    expect(res.ignoredFileSlug).toBeUndefined();
    // Derivation warnings ride the summary for the caller to print.
    expect(res.warnings).toEqual(["field `when` degraded to raw JSON"]);
    expect(upload).toHaveBeenCalledWith(
      "https://storage/put?sig",
      "application/gzip",
      artifact.tarball,
    );
    expect(create).toHaveBeenCalledWith("org", REF);
    expect(readLink(dir)).toEqual({ orgSlug: "org", workflowId: "new" });
  });

  it("asks confirmCreate before creating, and aborts (before upload) on a decline", async () => {
    const upload = vi.fn(() => Promise.resolve());
    const confirm = vi.fn(() => Promise.resolve(false));
    const client = fakeClient({ uploadArtifact: upload });
    await expect(
      deployWithLink(client, { orgSlug: "org", target: dir, prog, confirmCreate: confirm }),
    ).rejects.toThrow(/cancelled/);
    expect(confirm).toHaveBeenCalledWith({ slug: "n", orgSlug: "org" });
    expect(upload).not.toHaveBeenCalled();
    expect(readLink(dir)).toBeNull();
  });

  it("does NOT ask confirmCreate for an update/adopt deploy", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const client = fakeClient({ listWorkflows: () => Promise.resolve([wf("ex", "n")]) });
    const res = await deployWithLink(client, {
      orgSlug: "org",
      target: dir,
      prog,
      confirmCreate: confirm,
    });
    expect(res.outcome).toBe("adopted");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("resolves the org from a single-org credential when --org is omitted and no link exists", async () => {
    const create = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("new", "n"),
          version: { id: "v1", number: 1 },
          warnings: [],
        }),
    );
    const client = fakeClient({ getMe: () => Promise.resolve(me("solo")), createWorkflow: create });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.orgSlug).toBe("solo");
    expect(create).toHaveBeenCalledWith("solo", REF);
  });

  it("hard-errors (before uploading) on a multi-org credential with no --org and no link", async () => {
    const upload = vi.fn(() => Promise.resolve());
    const client = fakeClient({
      getMe: () => Promise.resolve(me("acme", "beta")),
      uploadArtifact: upload,
    });
    await expect(deployWithLink(client, { orgSlug: undefined, target: dir, prog })).rejects.toThrow(
      /No org selected/,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("errors when --org mismatches a single-org credential", async () => {
    const client = fakeClient({ getMe: () => Promise.resolve(me("solo")) });
    await expect(deployWithLink(client, { orgSlug: "other", target: dir, prog })).rejects.toThrow(
      /doesn't match/,
    );
  });

  it("adopts an existing same-name workflow when unlinked", async () => {
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("ex", "n"),
          version: { id: "v2", number: 2 },
          warnings: [],
        }),
    );
    const client = fakeClient({
      listWorkflows: () => Promise.resolve([wf("ex", "n")]),
      updateWorkflow: update,
    });
    const res = await deployWithLink(client, { orgSlug: "org", target: dir, prog });
    expect(res.outcome).toBe("adopted");
    expect(update).toHaveBeenCalledWith("ex", REF);
    expect(readLink(dir)?.workflowId).toBe("ex");
  });

  it("updates the linked workflow by id (ignoring name) when linked, and SURFACES the slug mismatch", async () => {
    writeLink(dir, { orgSlug: "org", workflowId: "linked-id" });
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("linked-id", "renamed"),
          version: { id: "v3", number: 3 },
          warnings: [],
        }),
    );
    const list = vi.fn(() => Promise.resolve([] as WorkflowSummary[]));
    const client = fakeClient({ updateWorkflow: update, listWorkflows: list });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.outcome).toBe("updated");
    expect(res.versionNumber).toBe(3);
    expect(update).toHaveBeenCalledWith("linked-id", REF);
    expect(list).not.toHaveBeenCalled(); // linked → no name lookup
    // The deployed workflow's real slug is "renamed", but the descriptor's slug is "n": report the
    // ACTUAL slug + flag the ignored slug so the caller warns instead of silently mislabeling.
    expect(res.deployedSlug).toBe("renamed");
    expect(res.ignoredFileSlug).toBe("n");
  });

  it("ignores the link's workflow id when the resolved org differs from the link's org", async () => {
    writeLink(dir, { orgSlug: "other-org", workflowId: "foreign-id" });
    const create = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("new", "n"),
          version: { id: "v1", number: 1 },
          warnings: [],
        }),
    );
    const client = fakeClient({
      getMe: () => Promise.resolve(me("org", "other-org")),
      createWorkflow: create,
    });
    const res = await deployWithLink(client, { orgSlug: "org", target: dir, prog });
    expect(res.outcome).toBe("created");
    expect(create).toHaveBeenCalledWith("org", REF);
    expect(readLink(dir)).toEqual({ orgSlug: "org", workflowId: "new" });
  });

  it("recreates when the linked workflow was deleted (404), confirming the create", async () => {
    writeLink(dir, { orgSlug: "org", workflowId: "stale" });
    const confirm = vi.fn(() => Promise.resolve(true));
    const client = fakeClient({
      updateWorkflow: () => Promise.reject(new CliError("gone", undefined, 404)),
      createWorkflow: () =>
        Promise.resolve({
          workflow: wf("fresh", "n"),
          version: { id: "v1", number: 1 },
          warnings: [],
        }),
    });
    const res = await deployWithLink(client, {
      orgSlug: undefined,
      target: dir,
      prog,
      confirmCreate: confirm,
    });
    expect(res.outcome).toBe("created");
    expect(res.workflowId).toBe("fresh");
    expect(confirm).toHaveBeenCalledOnce();
    expect(readLink(dir)?.workflowId).toBe("fresh");
  });

  it("uses the link's orgSlug when --org is omitted (multi-org credential)", async () => {
    writeLink(dir, { orgSlug: "from-link", workflowId: "wf-x" });
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("wf-x", "n"),
          version: { id: "v9", number: 9 },
          warnings: [],
        }),
    );
    const client = fakeClient({
      getMe: () => Promise.resolve(me("from-link", "another")),
      updateWorkflow: update,
    });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.orgSlug).toBe("from-link");
  });

  it("still works when /v1/me is unavailable: --org or the link carries the resolution", async () => {
    writeLink(dir, { orgSlug: "linked", workflowId: "wf-x" });
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({
          workflow: wf("wf-x", "n"),
          version: { id: "v9", number: 9 },
          warnings: [],
        }),
    );
    const client = fakeClient({
      getMe: () => Promise.reject(new CliError("older backend")),
      updateWorkflow: update,
    });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.orgSlug).toBe("linked");
  });
});
