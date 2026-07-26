// SPDX-License-Identifier: MIT

// `boardwalk workspace` — inspect and reset a workflow's PERSISTENT workspace:
//   • workspace show <workflow>    → what it's storing, per scope: size + last written
//   • workspace reset <workflow>   → clear ONE scope, so its next run starts empty (requires --yes)
//
// Every run gets a `/workspace` that is scratch unless the workflow opts in — `workspace.persist` in
// the manifest, or an `agent({ memory })` call, which compounds its directory with no declaration.
// What compounds is kept PER SCOPE — per environment (chosen at trigger time, not in the manifest,
// so one program runs against several) and per `workspace.key` (an author-set template scoping state
// per customer, repo, or tenant). `--environment` and `--key` address one; together they must select
// EXACTLY ONE, and reset refuses to guess when they don't.
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
  /** The resolved `workspace.key` to clear. Omitted addresses the scope with no key. */
  key?: string | undefined;
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

  const wantedKey = opts.key ?? null;
  const scopes = await client.listWorkspaces(workflow.id);
  const match = scopes.find(
    (w) => w.environmentId === environmentId && w.workspaceKey === wantedKey,
  );
  const scope = describeScope(opts.environment, wantedKey);

  if (match === undefined) {
    // Nothing under the addressed scope. If OTHER scopes exist, say so and list them rather than
    // reporting a clean "nothing to reset" — the user asked to clear state, and there IS state; they
    // just named the wrong scope. Silently succeeding here is how the wrong thing survives.
    if (scopes.length > 0) {
      throw new CliError(
        `${opts.workflow} has nothing persisted for ${scope}, but it does have other scopes.`,
        ["Name the one you mean:", ...formatWorkspaces(opts.workflow, scopes).slice(2)].join("\n"),
      );
    }
    log(`${opts.workflow} has nothing persisted for ${scope} — nothing to reset.`);
    return;
  }

  if (match.id === "") {
    throw new CliError(
      "This Boardwalk API is too old to address a workspace scope.",
      "Upgrade the control plane, or use the web UI.",
    );
  }

  if (opts.yes !== true) {
    // Say what will actually be lost, not just "are you sure": a size makes the difference between
    // "that's the cache, fine" and "that's four months of agent memory" obvious BEFORE the deletion.
    log(`About to reset the persistent workspace of ${opts.workflow} for ${scope}:`);
    log(`  ${formatBytes(match.bytes)}, last written ${formatAge(match.updatedAt)}`);
    log("");
    log("The next run starts from an empty workspace. This is irreversible, it leaves every OTHER");
    log("scope alone, and it does NOT affect the workflow, its triggers, or its history.");
    log("Re-run with --yes to confirm:");
    log(`  boardwalk workspace reset ${opts.workflow}${scopeFlags(opts)} --yes`);
    return;
  }
  try {
    await client.resetWorkspace(workflow.id, match.id);
    log(`✓ reset the persistent workspace of ${opts.workflow} for ${scope}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

/** How the addressed scope reads in prose. */
function describeScope(environment: string | undefined, key: string | null): string {
  const env = environment ?? "the base scope (runs with no environment)";
  return key === null ? env : `${env}, key "${key}"`;
}

/** The flags that re-address this scope, for the confirm line. */
function scopeFlags(opts: WorkspaceResetOptions): string {
  const env = opts.environment === undefined ? "" : ` --environment ${opts.environment}`;
  const key = opts.key === undefined ? "" : ` --key ${opts.key}`;
  return `${env}${key}`;
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
    // the scope, and to "(base)" for the no-environment scope. A workspace key is the author's own
    // string, so it is shown verbatim in its own column rather than folded into the environment.
    const env = w.environmentName ?? w.environmentId ?? "(base)";
    const key = w.workspaceKey ?? "";
    lines.push(
      `  ${env.padEnd(20)} ${key.padEnd(18)} ${formatBytes(w.bytes).padStart(9)}   last written ${formatAge(w.updatedAt)}`,
    );
  }
  lines.push("");
  lines.push(
    "Reset one with `boardwalk workspace reset <workflow> [--environment <name>] [--key <key>]`.",
  );
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
