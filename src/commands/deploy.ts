// SPDX-License-Identifier: MIT

// `boardwalk deploy <file|dir> [--org <slug>]` — ship a workflow program.
//
// Thin front-end over the REST create/update (which derives the manifest + reconciles triggers
// server-side). Identity is the project link (.boardwalk/project.json): once linked, --org is
// optional and the workflow is updated by id (rename-safe). `--dry-run` prints the plan only.

import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { BoardwalkClient } from "../client.js";
import { resolveLog } from "../log.js";
import { deployWithLink, loadProgram, planDeploy, type PreparedProgram } from "../deployment.js";
import { projectDirFor, readLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface DeployOptions {
  file: string;
  org?: string | undefined;
  check: boolean;
  /** Force esbuild bundling even for a single file (auto-on for a package directory). */
  token?: string | undefined;
}

export interface DeployDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export async function runDeploy(opts: DeployOptions, deps: DeployDeps): Promise<void> {
  const log = resolveLog(deps);

  const prog = await loadProgram(opts.file);
  const assets = prog.artifact.assetPaths.length;
  log(
    `  built ${prog.entry} (${String(prog.artifact.size)} bytes${assets > 0 ? `, ${String(assets)} asset${assets === 1 ? "" : "s"}` : ""})`,
  );

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { token, baseUrl } = await resolveApiTarget({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  if (opts.check) {
    await printPlan(client, opts, prog, log);
    return;
  }

  const dep = await deployWithLink(client, { orgSlug: opts.org, target: opts.file, prog });
  if (dep.gitignoreUpdated)
    log("  linked → .boardwalk/project.json (added .boardwalk/ to .gitignore)");
  if (dep.ignoredFileSlug !== undefined)
    log(
      `⚠ this directory is linked to workflow "${dep.deployedSlug}" — the file's slug "${dep.ignoredFileSlug}" was ignored (deployed as a new version of "${dep.deployedSlug}"). Deploy a different workflow from its own directory, or delete .boardwalk/ to re-link.`,
    );
  log(
    `✓ ${dep.outcome} "${dep.deployedSlug}" version ${String(dep.versionNumber)} (${dep.workflowId})`,
  );
}

/** Read-only preview of what `deploy` would do (no writes). */
async function printPlan(
  client: BoardwalkClient,
  opts: DeployOptions,
  prog: PreparedProgram,
  log: (line: string) => void,
): Promise<void> {
  const link = readLink(projectDirFor(opts.file));
  if (link !== null) {
    log(`plan: UPDATE linked workflow ${link.workflowId} (org ${link.orgSlug}) → new version`);
    return;
  }
  if (opts.org === undefined || opts.org.length === 0) {
    log(`plan: CREATE "${prog.slug}" (unlinked — pass --org to check for an existing match)`);
    return;
  }
  const plan = planDeploy(await client.listWorkflows(opts.org), prog.slug);
  log(
    plan.action === "create"
      ? `plan: CREATE "${prog.slug}" in org ${opts.org}`
      : `plan: ADOPT existing "${prog.slug}" (${plan.workflowId ?? "?"}) → new version`,
  );
}
