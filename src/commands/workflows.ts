// SPDX-License-Identifier: MIT

// `boardwalk workflows` — inspect + control the org's workflows from the terminal:
//   • workflows [list]       → the org's workflows as a compact table (needs an org).
//   • workflows show <ref>   → one workflow's manifest projection + versions (<ref> = id or slug).
//   • workflows disable <ref> → pause a workflow (it rejects every trigger; reversible).
//   • workflows enable <ref>  → re-enable a disabled workflow.
//   • workflows delete <ref>  → delete a workflow (requires --yes; destructive + irreversible).
//
// Org precedence (list + slug resolution): --org > the linked project's org. Auth precedence matches
// the other network commands: --token > BOARDWALK_API_KEY env > stored login. A workflow id (a ULID,
// as in a dashboard URL) needs no org; a slug is resolved against the org's list.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { WorkflowListItem, WorkflowDetail } from "../client.js";
import { resolveOrgClient } from "../org_client.js";
import { resolveLog } from "../log.js";
import { age } from "../age.js";
import { resolveWorkflowId } from "../workflow_ref.js";
import type { FetchLike } from "../auth/pkce.js";

export interface WorkflowsListOptions {
  org?: string | undefined;
  /** Server-side search: only workflows whose title or slug contains this (case-insensitive). */
  search?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkflowShowOptions {
  ref: string;
  org?: string | undefined;
  json?: boolean | undefined;
  /** Print the deployed program's source instead of the summary — the code that is actually running. */
  source?: boolean | undefined;
  token?: string | undefined;
}

export interface WorkflowDeleteOptions {
  ref: string;
  org?: string | undefined;
  /** Required to actually delete — without it we print the target and bail (destructive guard). */
  yes?: boolean | undefined;
  token?: string | undefined;
}

/** Options for `workflows disable` / `workflows enable` — identical shape (just the target + auth). */
export interface WorkflowToggleOptions {
  ref: string;
  org?: string | undefined;
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
  const log = resolveLog(deps);
  const now = deps.now ?? Date.now();
  const { client, org } = await resolveOrgClient(deps, opts);
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const search = opts.search?.trim();
  const workflows = await client.listWorkflowSummaries(
    org,
    search !== undefined && search !== "" ? { search } : {},
  );
  if (opts.json === true) {
    log(JSON.stringify({ workflows }, null, 2));
    return;
  }
  for (const line of formatWorkflowList(org, workflows, now, search)) log(line);
}

export async function runWorkflowShow(
  opts: WorkflowShowOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const id = await resolveWorkflowId(client, org, opts.ref);
  const detail = await client.getWorkflowDetail(id);
  if (opts.json === true) {
    log(JSON.stringify(detail, null, 2));
    return;
  }
  if (opts.source === true) {
    for (const line of formatWorkflowSource(detail)) log(line);
    return;
  }
  for (const line of formatWorkflowDetail(detail)) log(line);
}

/** The deployed program's source, ready to read or redirect to a file. A single-file program prints
 *  bare (so `> index.ts` just works); a package prints each file under a `// ==> path` banner. */
export function formatWorkflowSource(w: WorkflowDetail): string[] {
  if (w.source === null || w.source.length === 0) {
    throw new CliError(
      `No inlined source for ${w.slug}.`,
      "The program is too large to inline — fetch the artifact from the dashboard instead.",
    );
  }
  if (w.source.length === 1 && w.source[0] !== undefined) return [w.source[0].content];
  const out: string[] = [];
  for (const f of w.source) {
    out.push(`// ==> ${f.path}`, f.content);
  }
  return out;
}

export async function runWorkflowDelete(
  opts: WorkflowDeleteOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  const log = resolveLog(deps);
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
  try {
    await client.deleteWorkflow(id);
  } catch (err) {
    throw missingDeleteScopeHint(err);
  }
  log(`✓ deleted workflow ${label}.`);
}

/**
 * `workflow:delete` moved into the DEFAULT login's scope set, but a token's scopes are frozen at
 * authorize time and carried through every refresh — so a session predating the move keeps 403ing
 * until the user logs in again. A control plane predating it withholds the scope outright, and there
 * the elevated login is still the answer; the hint covers both rather than asserting a cause we
 * can't distinguish from a scope string. Role shortfalls and every other error pass through with the
 * backend's own reason.
 */
function missingDeleteScopeHint(err: unknown): unknown {
  if (
    err instanceof CliError &&
    err.status === 403 &&
    (err.hint ?? "").includes("workflow:delete")
  ) {
    return new CliError(
      "This session isn't permitted to delete workflows.",
      "Your login predates this permission (scopes freeze at login) — run `boardwalk login` again, " +
        "then retry as an org admin. If a fresh login still can't delete, your control plane is " +
        "older: use `boardwalk login --scopes admin`.",
      err.status,
    );
  }
  return err;
}

export async function runWorkflowDisable(
  opts: WorkflowToggleOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  return setWorkflowDisabled(opts, deps, true);
}

export async function runWorkflowEnable(
  opts: WorkflowToggleOptions,
  deps: WorkflowsDeps,
): Promise<void> {
  return setWorkflowDisabled(opts, deps, false);
}

/** Shared body for disable/enable: resolve the workflow, flip its state, confirm. No --yes guard —
 *  it's reversible (the opposite command undoes it). Disabling leaves in-flight + queued runs alone. */
async function setWorkflowDisabled(
  opts: WorkflowToggleOptions,
  deps: WorkflowsDeps,
  disabled: boolean,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const id = await resolveWorkflowId(client, org, opts.ref);
  const detail = await client.getWorkflowDetail(id);
  const label = `${detail.slug} (${detail.id})`;

  if (disabled) {
    await client.disableWorkflow(id);
    log(`✓ disabled workflow ${label}.`);
    log("Triggers (manual, scheduled, webhook) won't start new runs until you re-enable it.");
  } else {
    await client.enableWorkflow(id);
    log(`✓ enabled workflow ${label}.`);
  }
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

/** Render the workflow list as an aligned table. `now` renders the last-run age; `search` (the
 *  active `--search` term, if any) shapes the header + the empty-state line. */
export function formatWorkflowList(
  org: string,
  workflows: WorkflowListItem[],
  now: number,
  search?: string,
): string[] {
  const searching = search !== undefined && search !== "";
  if (workflows.length === 0) {
    return searching
      ? [`No workflows in ${org} match "${search}".`]
      : [`No workflows in ${org} yet — create one with \`boardwalk deploy\`.`];
  }
  const lines = [
    `Workflows · ${org}${searching ? ` · "${search}"` : ""}  (${String(workflows.length)})`,
    "",
    `  ${col("SLUG", SLUG_W)}${col("TITLE", TITLE_W)}${col("TRIGGERS", TRIGGERS_W)}LAST RUN`,
  ];
  for (const w of workflows) {
    const triggers = w.triggerKinds.length > 0 ? w.triggerKinds.join(",") : "—";
    // A disabled workflow gets a trailing marker (only disabled rows, so column alignment is intact).
    const mark = w.disabled ? "  · disabled" : "";
    lines.push(
      `  ${col(w.slug, SLUG_W)}${col(w.title ?? "—", TITLE_W)}${col(triggers, TRIGGERS_W)}${lastRun(w.lastRun, now)}${mark}`,
    );
  }
  return lines;
}

/** Render one workflow's detail as a label/value block. */
export function formatWorkflowDetail(w: WorkflowDetail): string[] {
  const lines = [`Workflow ${w.slug}`, "", field("Id", w.id)];
  // Only surface status when paused — an enabled workflow needs no line (keeps the block tight).
  if (w.disabled) lines.push(field("Status", "disabled"));
  if (w.title !== null) lines.push(field("Title", w.title));
  if (w.description !== null) lines.push(field("Description", w.description));
  // Trigger summaries carry the config a reader came to check (a cron's expr + timezone); the
  // bare kinds are the fallback for an older API's response.
  const triggerLines = w.triggerSummaries.length > 0 ? w.triggerSummaries : w.triggers;
  lines.push(field("Triggers", triggerLines.length > 0 ? (triggerLines[0] ?? "—") : "—"));
  for (const extra of triggerLines.slice(1)) lines.push(field("", extra));
  // The derived I/O contract — otherwise invisible outside the dashboard's run form.
  lines.push(field("Input", schemaSummary(w.inputSchema) ?? "(untyped)"));
  const output = schemaSummary(w.outputSchema);
  if (output !== null) lines.push(field("Output", output));
  lines.push(field("Secrets", w.secrets.length > 0 ? w.secrets.join(", ") : "—"));
  if (w.entry !== null) lines.push(field("Entry", w.entry));
  // Name the source files, never dump them — `--source` prints the code on demand.
  if (w.source !== null && w.source.length > 0) {
    lines.push(field("Source", w.source.map((f) => f.path).join(", ")));
  }

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

/** One-line digest of a derived JSON-schema object: `topic: string · style: "terse" | "friendly"
 *  · bullets?: number`. Null when there is nothing legible to say (no properties). Exported for
 *  tests. */
export function schemaSummary(schema: Record<string, unknown> | null): string | null {
  if (schema === null) return null;
  const props = schema.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r) => typeof r === "string") : [],
  );
  const parts: string[] = [];
  for (const [name, def] of Object.entries(props)) {
    parts.push(`${name}${required.has(name) ? "" : "?"}: ${typeLabel(def)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function typeLabel(def: unknown): string {
  if (typeof def !== "object" || def === null || Array.isArray(def)) return "any";
  const d = def as Record<string, unknown>;
  if (Array.isArray(d.enum)) return d.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (d.type === "array") return `${typeLabel(d.items)}[]`;
  if (typeof d.type === "string") return d.type;
  if (Array.isArray(d.anyOf) || Array.isArray(d.oneOf)) return "union";
  return "any";
}

/** "completed · 2h ago" / "never run" for the last-run column. */
function lastRun(run: { status: string; at: number } | null, now: number): string {
  if (run === null) return "never run";
  return `${run.status} · ${age(run.at, now)} ago`;
}
