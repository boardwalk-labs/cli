// SPDX-License-Identifier: MIT

// `boardwalk workflows` — inspect the org's workflows from the terminal:
//   • workflows [list]      → the org's workflows as a compact table (needs an org).
//   • workflows show <ref>  → one workflow's manifest projection + versions (<ref> = id or slug).
//   • workflows delete <ref> → delete a workflow (requires --yes; destructive + irreversible).
//
// Org precedence (list + slug resolution): --org > the linked project's org. Auth precedence matches
// the other network commands: --token > BOARDWALK_API_KEY env > stored login. A workflow id (a ULID,
// as in a dashboard URL) needs no org; a slug is resolved against the org's list.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { WorkflowListItem, WorkflowDetail } from "../client.js";
import { resolveOrgClient } from "../org_client.js";
import { resolveWorkflowId } from "../workflow_ref.js";
import type { FetchLike } from "../auth/pkce.js";

export interface WorkflowsListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkflowShowOptions {
  ref: string;
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkflowDeleteOptions {
  ref: string;
  org?: string | undefined;
  /** Required to actually delete — without it we print the target and bail (destructive guard). */
  yes?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkflowsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
  now?: number;
}

export async function runWorkflowsList(
  opts: WorkflowsListOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const now = deps.now ?? Date.now();
  const { client, org } = await resolveOrgClient(deps, opts);
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const workflows = await client.listWorkflowSummaries(org);
  if (opts.json === true) {
    log(JSON.stringify({ workflows }, null, 2));
    return;
  }
  for (const line of formatWorkflowList(org, workflows, now)) log(line);
}

export async function runWorkflowShow(
  opts: WorkflowShowOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const { client, org } = await resolveOrgClient(deps, opts);
  const id = await resolveWorkflowId(client, org, opts.ref);
  const detail = await client.getWorkflowDetail(id);
  if (opts.json === true) {
    log(JSON.stringify(detail, null, 2));
    return;
  }
  for (const line of formatWorkflowDetail(detail)) log(line);
}

export async function runWorkflowDelete(
  opts: WorkflowDeleteOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const { client, org } = await resolveOrgClient(deps, opts);
  const id = await resolveWorkflowId(client, org, opts.ref);
  const detail = await client.getWorkflowDetail(id);
  const label = `${detail.slug} (${detail.id})`;

  if (opts.yes !== true) {
    log(`About to delete workflow ${label}.`);
    log("This is irreversible — its versions + run history go with it.");
    log("Re-run with --yes to confirm:");
    log(`  boardwalk workflows delete ${opts.ref.trim()} --yes`);
    return;
  }
  await client.deleteWorkflow(id);
  log(`✓ deleted workflow ${label}.`);
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

/** Render the workflow list as an aligned table. `now` renders the last-run age. */
export function formatWorkflowList(
  org: string,
  workflows: WorkflowListItem[],
  now: number,
): string[] {
  if (workflows.length === 0) {
    return [`No workflows in ${org} yet — create one with \`boardwalk deploy\`.`];
  }
  const lines = [
    `Workflows · ${org}  (${String(workflows.length)})`,
    "",
    `  ${col("SLUG", SLUG_W)}${col("TITLE", TITLE_W)}${col("TRIGGERS", TRIGGERS_W)}LAST RUN`,
  ];
  for (const w of workflows) {
    const triggers = w.triggerKinds.length > 0 ? w.triggerKinds.join(",") : "—";
    lines.push(
      `  ${col(w.slug, SLUG_W)}${col(w.title ?? "—", TITLE_W)}${col(triggers, TRIGGERS_W)}${lastRun(w.lastRun, now)}`,
    );
  }
  return lines;
}

/** Render one workflow's detail as a label/value block. */
export function formatWorkflowDetail(w: WorkflowDetail): string[] {
  const lines = [`Workflow ${w.slug}`, "", field("Id", w.id)];
  if (w.title !== null) lines.push(field("Title", w.title));
  if (w.description !== null) lines.push(field("Description", w.description));
  lines.push(field("Triggers", w.triggers.length > 0 ? w.triggers.join(", ") : "—"));
  lines.push(field("Secrets", w.secrets.length > 0 ? w.secrets.join(", ") : "—"));
  if (w.entry !== null) lines.push(field("Entry", w.entry));

  const current = w.versions.find((v) => v.id === w.currentVersionId);
  lines.push(
    field("Version", current !== undefined ? `v${String(current.number)} (current)` : "—"),
  );
  if (w.versions.length > 0) {
    lines.push("");
    lines.push(`  Versions (${String(w.versions.length)}):`);
    for (const v of w.versions) {
      const marker = v.id === w.currentVersionId ? "→" : " ";
      lines.push(`  ${marker} v${col(String(v.number), 4)}${v.id}`);
    }
  }
  return lines;
}

const SLUG_W = 28;
const TITLE_W = 30;
const TRIGGERS_W = 16;

/** Left-justify `s` to `width`, truncating with `…` when too long. */
function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}

/** A "  Label   value" detail row. */
function field(label: string, value: string): string {
  return `  ${label.padEnd(12)} ${value}`;
}

/** "completed · 2h ago" / "never run" for the last-run column. */
function lastRun(run: { status: string; at: number } | null, now: number): string {
  if (run === null) return "never run";
  return `${run.status} · ${age(run.at, now)} ago`;
}

/** Coarse "time since" label: 45s / 12m / 3h / 5d. */
function age(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)}h`;
  return `${String(Math.round(h / 24))}d`;
}
