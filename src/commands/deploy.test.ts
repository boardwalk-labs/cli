// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import type { CliConfig } from "../config.js";

const mocks = vi.hoisted(() => ({
  loadProgram: vi.fn(),
  deployWithLink: vi.fn(),
  planDeploy: vi.fn(),
  resolveToken: vi.fn(),
  credentialStoreAtConfigDir: vi.fn(),
  boardwalkClient: vi.fn(),
  projectDirFor: vi.fn(),
  readLink: vi.fn(),
  listWorkflows: vi.fn(),
  clientOptions: [] as unknown[],
  client: undefined as unknown,
  store: undefined as unknown,
}));

vi.mock("../deployment.js", () => ({
  loadProgram: mocks.loadProgram,
  deployWithLink: mocks.deployWithLink,
  planDeploy: mocks.planDeploy,
}));

vi.mock("../auth/resolve.js", () => ({
  resolveToken: mocks.resolveToken,
}));

vi.mock("../credentials.js", () => ({
  CredentialStore: {
    atConfigDir: mocks.credentialStoreAtConfigDir,
  },
}));

vi.mock("../client.js", () => ({
  BoardwalkClient: mocks.boardwalkClient,
}));

vi.mock("../project.js", () => ({
  projectDirFor: mocks.projectDirFor,
  readLink: mocks.readLink,
}));

import { runDeploy } from "./deploy.js";

const config = {
  configDir: "/config/dir",
  apiBaseUrl: "https://api.example.test",
} as CliConfig;

function preparedProgram(overrides: Record<string, unknown> = {}) {
  return {
    entry: "index.mjs",
    slug: "demo-workflow",
    artifact: {
      size: 321,
      assetPaths: ["skills/review.md"],
    },
    ...overrides,
  };
}

function resetMocks(): void {
  mocks.loadProgram.mockReset();
  mocks.deployWithLink.mockReset();
  mocks.planDeploy.mockReset();
  mocks.resolveToken.mockReset();
  mocks.credentialStoreAtConfigDir.mockReset();
  mocks.boardwalkClient.mockReset();
  mocks.projectDirFor.mockReset();
  mocks.readLink.mockReset();
  mocks.listWorkflows.mockReset();
  mocks.clientOptions.length = 0;

  mocks.store = { kind: "credential-store" };
  mocks.client = { listWorkflows: mocks.listWorkflows };

  mocks.credentialStoreAtConfigDir.mockReturnValue(mocks.store);
  mocks.resolveToken.mockResolvedValue("resolved-token");
  mocks.boardwalkClient.mockImplementation(function (_options: unknown) {
    mocks.clientOptions.push(_options);
    return mocks.client;
  });
  mocks.projectDirFor.mockImplementation((target: string) => `/project-dir-for/${target}`);
  mocks.readLink.mockReturnValue(null);
  mocks.planDeploy.mockReturnValue({ action: "create" });
}

describe("runDeploy", () => {
  it("resolves the program, creates a deployment with the expected project/artifact options, and prints the resulting id", async () => {
    resetMocks();
    const prog = preparedProgram();
    const fetchImpl = vi.fn();
    const log = vi.fn();

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.deployWithLink.mockResolvedValue({
      gitignoreUpdated: true,
      outcome: "deployed",
      versionNumber: 7,
      workflowId: "wf_123",
    });

    await runDeploy(
      {
        file: "/repo/workflows/demo.ts",
        org: "acme",
        check: false,
        token: "token-from-flag",
      },
      {
        config,
        fetchImpl,
        log,
      },
    );

    expect(mocks.loadProgram).toHaveBeenCalledWith("/repo/workflows/demo.ts");
    expect(mocks.credentialStoreAtConfigDir).toHaveBeenCalledWith("/config/dir");
    expect(mocks.resolveToken).toHaveBeenCalledWith({
      config,
      store: mocks.store,
      tokenFlag: "token-from-flag",
      fetchImpl,
    });
    expect(mocks.boardwalkClient).toHaveBeenCalledTimes(1);
    expect(mocks.clientOptions).toEqual([
      {
        baseUrl: "https://api.example.test",
        token: "resolved-token",
        fetchImpl,
      },
    ]);
    expect(mocks.deployWithLink).toHaveBeenCalledWith(mocks.client, {
      orgSlug: "acme",
      target: "/repo/workflows/demo.ts",
      prog,
    });
    expect(log).toHaveBeenCalledWith("  built index.mjs (321 bytes, 1 asset)");
    expect(log).toHaveBeenCalledWith(
      "  linked → .boardwalk/project.json (added .boardwalk/ to .gitignore)",
    );
    expect(log).toHaveBeenCalledWith('✓ deployed "demo-workflow" version 7 (wf_123)');
  });

  it("fails with a clear program/configuration error before attempting auth, client creation, or deployment", async () => {
    resetMocks();
    const log = vi.fn();

    mocks.loadProgram.mockRejectedValue(new Error("invalid project configuration: missing entry file"));

    await expect(
      runDeploy(
        {
          file: "/repo/missing",
          org: "acme",
          check: false,
        },
        {
          config,
          log,
        },
      ),
    ).rejects.toThrow("invalid project configuration: missing entry file");

    expect(mocks.resolveToken).not.toHaveBeenCalled();
    expect(mocks.credentialStoreAtConfigDir).not.toHaveBeenCalled();
    expect(mocks.boardwalkClient).not.toHaveBeenCalled();
    expect(mocks.deployWithLink).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("surfaces an API validation failure during deployment creation and does not print success", async () => {
    resetMocks();
    const prog = preparedProgram({ artifact: { size: 99, assetPaths: [] } });
    const log = vi.fn();
    const serverError = Object.assign(
      new Error("422 Unprocessable Entity: manifest.slug is required"),
      { status: 422 },
    );

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.deployWithLink.mockRejectedValue(serverError);

    await expect(
      runDeploy(
        {
          file: "/repo/bad.ts",
          org: "acme",
          check: false,
        },
        {
          config,
          log,
        },
      ),
    ).rejects.toThrow("422 Unprocessable Entity: manifest.slug is required");

    expect(mocks.deployWithLink).toHaveBeenCalledWith(mocks.client, {
      orgSlug: "acme",
      target: "/repo/bad.ts",
      prog,
    });
    expect(log).toHaveBeenCalledWith("  built index.mjs (99 bytes)");
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^✓ /));
  });

  it("propagates parsed deploy options exactly to the deployment request", async () => {
    resetMocks();
    const prog = preparedProgram({
      slug: "named-workflow",
      entry: "dist/workflow.mjs",
      artifact: {
        size: 2048,
        assetPaths: ["a.json", "b.md"],
      },
    });
    const log = vi.fn();

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.deployWithLink.mockResolvedValue({
      gitignoreUpdated: false,
      outcome: "updated",
      versionNumber: 42,
      workflowId: "wf_named",
    });

    await runDeploy(
      {
        file: "relative/workflow-dir",
        org: "team-slug",
        check: false,
        token: "explicit-token",
      },
      {
        config,
        log,
      },
    );

    expect(mocks.resolveToken).toHaveBeenCalledWith({
      config,
      store: mocks.store,
      tokenFlag: "explicit-token",
    });
    expect(mocks.deployWithLink).toHaveBeenCalledWith(mocks.client, {
      orgSlug: "team-slug",
      target: "relative/workflow-dir",
      prog,
    });
    expect(log).toHaveBeenCalledWith("  built dist/workflow.mjs (2048 bytes, 2 assets)");
    expect(log).toHaveBeenCalledWith('✓ updated "named-workflow" version 42 (wf_named)');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(".gitignore"));
  });

  it("in check mode, prints an update plan for a linked workflow and does not deploy", async () => {
    resetMocks();
    const prog = preparedProgram();
    const log = vi.fn();

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.readLink.mockReturnValue({
      orgSlug: "linked-org",
      workflowId: "wf_linked",
    });

    await runDeploy(
      {
        file: "/repo/linked",
        org: undefined,
        check: true,
      },
      {
        config,
        log,
      },
    );

    expect(mocks.projectDirFor).toHaveBeenCalledWith("/repo/linked");
    expect(mocks.readLink).toHaveBeenCalledWith("/project-dir-for//repo/linked");
    expect(mocks.listWorkflows).not.toHaveBeenCalled();
    expect(mocks.planDeploy).not.toHaveBeenCalled();
    expect(mocks.deployWithLink).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("  built index.mjs (321 bytes, 1 asset)");
    expect(log).toHaveBeenCalledWith(
      "plan: UPDATE linked workflow wf_linked (org linked-org) → new version",
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringMatching(/^✓ /));
  });

  it("in check mode, prints an unlinked create plan when no org is supplied", async () => {
    resetMocks();
    const prog = preparedProgram({ slug: "unlinked-workflow" });
    const log = vi.fn();

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.readLink.mockReturnValue(null);

    await runDeploy(
      {
        file: "/repo/unlinked.ts",
        check: true,
      },
      {
        config,
        log,
      },
    );

    expect(mocks.projectDirFor).toHaveBeenCalledWith("/repo/unlinked.ts");
    expect(mocks.readLink).toHaveBeenCalledWith("/project-dir-for//repo/unlinked.ts");
    expect(mocks.listWorkflows).not.toHaveBeenCalled();
    expect(mocks.planDeploy).not.toHaveBeenCalled();
    expect(mocks.deployWithLink).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'plan: CREATE "unlinked-workflow" (unlinked — pass --org to check for an existing match)',
    );
  });

  it("in check mode with an org, lists workflows, plans adoption, and does not deploy", async () => {
    resetMocks();
    const prog = preparedProgram({ slug: "existing-workflow" });
    const workflows = [{ id: "wf_existing", slug: "existing-workflow" }];
    const log = vi.fn();

    mocks.loadProgram.mockResolvedValue(prog);
    mocks.readLink.mockReturnValue(null);
    mocks.listWorkflows.mockResolvedValue(workflows);
    mocks.planDeploy.mockReturnValue({
      action: "adopt",
      workflowId: "wf_existing",
    });

    await runDeploy(
      {
        file: "/repo/existing.ts",
        org: "acme",
        check: true,
      },
      {
        config,
        log,
      },
    );

    expect(mocks.listWorkflows).toHaveBeenCalledWith("acme");
    expect(mocks.planDeploy).toHaveBeenCalledWith(workflows, "existing-workflow");
    expect(mocks.deployWithLink).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'plan: ADOPT existing "existing-workflow" (wf_existing) → new version',
    );
  });
});
