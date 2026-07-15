// SPDX-License-Identifier: MIT

// `boardwalk workspace` — inspect and reset a workflow's PERSISTENT workspace:
//   • workspace show <workflow>    → what it's storing, per environment: size + last written
//   • workspace reset <workflow>   → clear it, so the next run starts empty (requires --yes)
//
// Every run gets a `/workspace` that is scratch unless the workflow opts in — `workspace.persist` in
// the manifest, or an `agent({ memory })` call, which compounds its directory with no declaration.
// What compounds is kept PER ENVIRONMENT: one workflow program runs against several (an environment
// is chosen at trigger time, not in the manifest), so `--environment` addresses one of them and the
// default addresses the base scope (runs with no environment).
//
// Reset exists because state that compounds eventually compounds something wrong — a poisoned cache,
// an agent memory that learned the wrong lesson, a half-finished index from a failed run. It clears
// the state only: the workflow, its triggers, its schedules, and its history all stay.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { WorkspaceScopeItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface WorkspaceShowOptions {
  workflow: string;
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkspaceResetOptions {
  workflow: string;
  environment?: string | undefined;
  yes?: boolean | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface WorkspaceDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export async function runWorkspaceShow(
  opts: WorkspaceShowOptions,
  deps: WorkspaceDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const workflow = await resolveWorkflow(client, requireOrg(org), opts.workflow);
  const workspaces = await client.listWorkspaces(workflow.id);
  if (opts.json === true) {
    log(JSON.stringify({ workspaces }, null, 2));
    return;
  }
  for (const line of formatWorkspaces(opts.workflow, workspaces)) log(line);
}

export async function runWorkspaceReset(
  opts: WorkspaceResetOptions,
  deps: WorkspaceDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  const workflow = await resolveWorkflow(client, resolvedOrg, opts.workflow);

  // The API is keyed by environment ID; the CLI speaks names, like every other environment surface.
  let environmentId: string | null = null;
  if (opts.environment !== undefined) {
    const target = (await client.listEnvironments(resolvedOrg)).find(
      (e) => e.name === opts.environment,
    );
    if (target === undefined) {
      throw new CliError(
        `No environment "${opts.environment}" in ${resolvedOrg}.`,
        "Check the name with `boardwalk environments list`.",
      );
    }
    environmentId = target.id;
  }

  const scope = opts.environment ?? "the base scope (runs with no environment)";
  if (opts.yes !== true) {
    // Say what will actually be lost, not just "are you sure": a size makes the difference between
    // "that's the cache, fine" and "that's four months of agent memory" obvious BEFORE the deletion.
    const current = (await client.listWorkspaces(workflow.id)).find(
      (w) => w.environmentId === environmentId,
    );
    if (current === undefined) {
      log(`${opts.workflow} has nothing persisted for ${scope} — nothing to reset.`);
      return;
    }
    log(`About to reset the persistent workspace of ${opts.workflow} for ${scope}:`);
    log(`  ${formatBytes(current.bytes)}, last written ${formatAge(current.updatedAt)}`);
    log("");
    log("The next run starts from an empty workspace. This is irreversible, and it does NOT");
    log("affect the workflow, its triggers, or its history. Re-run with --yes to confirm:");
    const envFlag = opts.environment === undefined ? "" : ` --environment ${opts.environment}`;
    log(`  boardwalk workspace reset ${opts.workflow}${envFlag} --yes`);
    return;
  }
  try {
    await client.resetWorkspace(workflow.id, environmentId);
    log(`✓ reset the persistent workspace of ${opts.workflow} for ${scope}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

/** Resolve a workflow by SLUG (what a user types) to the row the API is keyed by. */
async function resolveWorkflow(
  client: { listWorkflows: (org: string) => Promise<{ id: string; slug: string }[]> },
  org: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const match = (await client.listWorkflows(org)).find((w) => w.slug === slug || w.id === slug);
  if (match === undefined) {
    throw new CliError(
      `No workflow "${slug}" in ${org}.`,
      "List them with `boardwalk workflows list`.",
    );
  }
  return match;
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

export function formatWorkspaces(workflow: string, workspaces: WorkspaceScopeItem[]): string[] {
  if (workspaces.length === 0) {
    return [
      `${workflow} has no persistent workspace yet.`,
      "",
      "A workspace is scratch unless the workflow opts in: declare `workspace: { persist: [...] }`",
      "in the manifest, or give an agent() call a `memory` directory.",
    ];
  }
  const lines = [`Persistent workspace · ${workflow}`, ""];
  for (const w of workspaces) {
    // Name it by environment; fall back to the raw id if the environment was deleted out from under
    // the snapshot, and to "(base)" for the no-environment scope.
    const scope = w.environmentName ?? w.environmentId ?? "(base)";
    lines.push(
      `  ${scope.padEnd(20)} ${formatBytes(w.bytes).padStart(9)}   last written ${formatAge(w.updatedAt)}`,
    );
  }
  lines.push("");
  lines.push("Reset one with `boardwalk workspace reset <workflow> [--environment <name>]`.");
  return lines;
}

/** Human bytes. Binary units, because that's what a tarball's size means. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "GB"}`;
}

/** Coarse relative age — the question is "is this stale?", never the exact timestamp. */
export function formatAge(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}
