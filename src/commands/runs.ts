// SPDX-License-Identifier: MIT

// `boardwalk runs [runId]` — two modes:
//   • no id  → the org's recent runs as a compact table (GET /orgs/:slug/runs); needs an org.
//   • <runId> → one run's detail (GET /runs/:id); the endpoint resolves the org, so NO --org needed.
//
// Org precedence (list mode): --org > the linked project's org (.boardwalk/project.json). Auth
// precedence matches the other network commands: --token > BOARDWALK_API_KEY env > stored login.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken } from "../auth/resolve.js";
import { BoardwalkClient, type RunListItem, type RunDetail } from "../client.js";
import { readLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface RunsOptions {
  /** When set, show this single run's detail instead of the org list (no --org needed). */
  runId?: string | undefined;
  org?: string | undefined;
  status?: string | undefined;
  limit?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface RunsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
  /** Wall-clock used to render ages (defaults to Date.now()). */
  now?: number;
}

export async function runRuns(opts: RunsOptions, deps: RunsDeps): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });

  const runId = (opts.runId ?? "").trim();
  const now = deps.now ?? Date.now();

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const token = await resolveToken({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl: deps.config.apiBaseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // Single-run detail — the endpoint resolves the org from the run id, so no --org is needed.
  if (runId.length > 0) {
    const run = await client.getRunDetail(runId);
    if (opts.json === true) {
      log(JSON.stringify(run, null, 2));
      return;
    }
    for (const line of formatRunDetail(run, now)) log(line);
    return;
  }

  // Org list — needs an org (from --org or the linked project).
  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const limit = parseLimit(opts.limit);
  const status = (opts.status ?? "").trim();

  const result = await client.listOrgRuns(org, {
    ...(status.length > 0 ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (opts.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of formatRuns(org, result.runs, now)) log(line);
  if (result.nextCursor !== null) {
    log("");
    log("  More runs available — raise --limit or filter with --status.");
  }
}

/** Parse + validate the `--limit` (a positive whole number), or undefined for the server default. */
function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(
      `Invalid --limit "${value}".`,
      "Use a positive whole number, e.g. --limit 20.",
    );
  }
  return n;
}

/** Render the runs list as an aligned plain-text table (pure — exported for tests). `now` renders ages. */
export function formatRuns(org: string, runs: RunListItem[], now: number): string[] {
  if (runs.length === 0) {
    return [`No runs for ${org} in this window.`];
  }
  const lines = [
    `Runs · ${org}  (${String(runs.length)})`,
    "",
    `  ${col("RUN ID", ID_W)}${col("WORKFLOW", WF_W)}${col("STATUS", STATUS_W)}${col("TRIGGER", TRIGGER_W)}${col("AGE", AGE_W)}DURATION`,
  ];
  for (const r of runs) {
    const wf = r.workflowSlug ?? r.workflowId;
    lines.push(
      `  ${col(r.id, ID_W)}${col(wf, WF_W)}${col(r.status, STATUS_W)}${col(r.triggerKind ?? "—", TRIGGER_W)}${col(age(r.createdAt, now), AGE_W)}${duration(r.runtimeSeconds)}`,
    );
  }
  return lines;
}

/** Render one run's detail as a label/value block (pure — exported for tests). `now` renders ages. */
export function formatRunDetail(run: RunDetail, now: number): string[] {
  const status = run.outcomeStatus === null ? run.status : `${run.status} (${run.outcomeStatus})`;
  const lines = [
    `Run ${run.id}`,
    "",
    field("Workflow", run.workflowSlug ?? run.workflowId),
    field("Status", status),
    field("Trigger", run.triggerKind ?? "—"),
    field("Created", `${isoUtc(run.createdAt)}  (${age(run.createdAt, now)} ago)`),
  ];
  if (run.startedAt !== null) lines.push(field("Started", isoUtc(run.startedAt)));
  if (run.completedAt !== null) lines.push(field("Finished", isoUtc(run.completedAt)));
  lines.push(field("Duration", duration(run.runtimeSeconds)));

  const tokens = run.tokensIn + run.tokensOut;
  if (tokens > 0) {
    lines.push(
      field(
        "Tokens",
        `${compact(tokens)}  (${compact(run.tokensIn)} in · ${compact(run.tokensOut)} out)`,
      ),
    );
  }
  if (run.error !== null) lines.push(field("Error", `${run.error.code}: ${run.error.message}`));
  return lines;
}

const ID_W = 32;
const WF_W = 24;
const STATUS_W = 12;
const TRIGGER_W = 10;
const AGE_W = 7;

/** Left-justify `s` to `width`, truncating with `…` when it's too long. */
function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}

/** A "  Label   value" detail row. */
function field(label: string, value: string): string {
  return `  ${label.padEnd(10)} ${value}`;
}

/** Epoch ms → "YYYY-MM-DD HH:MM:SS UTC". */
function isoUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** 18432 → "18.4K", 1_840_000 → "1.8M". Mirrors the usage command's compact format. */
function compact(n: number): string {
  if (Math.abs(n) < 1_000) return n.toLocaleString("en-US");
  if (Math.abs(n) < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
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

/** Billed runtime as "45s" / "1m 23s" / "2h 3m"; "—" while a run is still in flight (0s). */
function duration(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds < 60) return `${String(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${String(m)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60)}m`;
}
