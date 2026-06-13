// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./errors.js";
import { loadProgram, planDeploy, deployWithLink, type PreparedProgram } from "./deployment.js";
import { readLink, writeLink } from "./project.js";
import type { BuiltArtifact } from "./artifact.js";
import type {
  BoardwalkClient,
  WorkflowSummary,
  DeployResult,
  DeployArtifactRef,
} from "./client.js";

function wf(id: string, name: string): WorkflowSummary {
  return { id, name, currentVersionId: "v1" };
}

describe("planDeploy", () => {
  it("plans a create when no workflow matches the name", () => {
    expect(planDeploy([wf("wf1", "other")], "new-one")).toEqual({
      action: "create",
      name: "new-one",
    });
  });

  it("plans an update (with the id) when a workflow matches by name", () => {
    expect(planDeploy([wf("wf1", "a"), wf("wf2", "target")], "target")).toEqual({
      action: "update",
      name: "target",
      workflowId: "wf2",
    });
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

  it("builds a single file into a content-addressed artifact", async () => {
    const file = join(dir, "wf.ts");
    writeFileSync(file, `export const meta = { name: "solo", description: "d" };`);
    const prog = await loadProgram(file);
    expect(prog.name).toBe("solo");
    expect(prog.entry).toBe("index.mjs");
    expect(prog.artifact.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(prog.artifact.assetPaths).toEqual([]);
    expect(prog.artifact.entrySource).toContain("solo"); // meta survives for name extraction
  });

  it("builds a package directory + its assets", async () => {
    mkdirSync(join(dir, "skills"));
    writeFileSync(join(dir, "skills", "s.md"), "# skill");
    writeFileSync(join(dir, "index.ts"), `export const meta = { name: "pkg" };`);
    const prog = await loadProgram(dir);
    expect(prog.name).toBe("pkg");
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
      listWorkflows: () => Promise.resolve([]),
      getArtifactUploadUrl: () =>
        Promise.resolve({ uploadUrl: "https://storage/put?sig", contentType: "application/gzip" }),
      uploadArtifact: () => Promise.resolve(),
      createWorkflow: () =>
        Promise.resolve({ workflow: wf("new", "n"), version: { id: "v1", number: 1 } }),
      updateWorkflow: () =>
        Promise.resolve({ workflow: wf("ex", "n"), version: { id: "v2", number: 2 } }),
      ...over,
    } as unknown as BoardwalkClient;
  }

  const artifact: BuiltArtifact = {
    tarball: new Uint8Array([1, 2, 3]),
    digest: "a".repeat(64),
    size: 3,
    entry: "index.mjs",
    sdkVersion: "*",
    lockfileDigest: null,
    entrySource: `export const meta = { name: "n" };`,
    assetPaths: [],
  };
  const prog: PreparedProgram = { name: "n", entry: "index.mjs", artifact };
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
        Promise.resolve({ workflow: wf("new", "n"), version: { id: "v1", number: 1 } }),
    );
    const client = fakeClient({
      listWorkflows: () => Promise.resolve([]),
      uploadArtifact: upload,
      createWorkflow: create,
    });
    const res = await deployWithLink(client, { orgSlug: "org", target: dir, prog });
    expect(res.outcome).toBe("created");
    expect(res.workflowId).toBe("new");
    expect(upload).toHaveBeenCalledWith(
      "https://storage/put?sig",
      "application/gzip",
      artifact.tarball,
    );
    expect(create).toHaveBeenCalledWith("org", REF);
    expect(readLink(dir)).toEqual({ orgSlug: "org", workflowId: "new" });
  });

  it("adopts an existing same-name workflow when unlinked", async () => {
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({ workflow: wf("ex", "n"), version: { id: "v2", number: 2 } }),
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

  it("updates the linked workflow by id (ignoring name) when linked", async () => {
    writeLink(dir, { orgSlug: "org", workflowId: "linked-id" });
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({ workflow: wf("linked-id", "renamed"), version: { id: "v3", number: 3 } }),
    );
    const list = vi.fn(() => Promise.resolve([] as WorkflowSummary[]));
    const client = fakeClient({ updateWorkflow: update, listWorkflows: list });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.outcome).toBe("updated");
    expect(res.versionNumber).toBe(3);
    expect(update).toHaveBeenCalledWith("linked-id", REF);
    expect(list).not.toHaveBeenCalled(); // linked → no name lookup
  });

  it("recreates when the linked workflow was deleted (404)", async () => {
    writeLink(dir, { orgSlug: "org", workflowId: "stale" });
    const client = fakeClient({
      updateWorkflow: () => Promise.reject(new CliError("gone", undefined, 404)),
      createWorkflow: () =>
        Promise.resolve({ workflow: wf("fresh", "n"), version: { id: "v1", number: 1 } }),
    });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.outcome).toBe("created");
    expect(res.workflowId).toBe("fresh");
    expect(readLink(dir)?.workflowId).toBe("fresh");
  });

  it("throws when there's no --org and no link (before uploading)", async () => {
    const upload = vi.fn(() => Promise.resolve());
    const client = fakeClient({ uploadArtifact: upload });
    await expect(deployWithLink(client, { orgSlug: undefined, target: dir, prog })).rejects.toThrow(
      /No org/,
    );
    expect(upload).not.toHaveBeenCalled();
  });

  it("uses the link's orgSlug when --org is omitted", async () => {
    writeLink(dir, { orgSlug: "from-link", workflowId: "wf-x" });
    const update = vi.fn(
      (): Promise<DeployResult> =>
        Promise.resolve({ workflow: wf("wf-x", "n"), version: { id: "v9", number: 9 } }),
    );
    const client = fakeClient({ updateWorkflow: update });
    const res = await deployWithLink(client, { orgSlug: undefined, target: dir, prog });
    expect(res.orgSlug).toBe("from-link");
  });
});
