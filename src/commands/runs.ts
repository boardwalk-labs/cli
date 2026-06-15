// SPDX-License-Identifier: MIT

// `boardwalk runs [--org <slug>] [--status <s>] [--limit <n>]` — the org's recent runs, newest first,
// as a compact table (id, workflow, status, trigger, age, duration). Read-only (GET /orgs/:slug/runs).
//
// Org precedence: --org > the linked project's org (.boardwalk/project.json). Auth precedence matches
// the other network commands: --token > BOARDWALK_API_KEY env > stored login.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken } from "../auth/resolve.js";
import { BoardwalkClient, type RunListItem } from "../client.js";
import { readLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface RunsOptions {
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

  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const limit = parseLimit(opts.limit);
  const status = (opts.status ?? "").trim();

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

  const result = await client.listOrgRuns(org, {
    ...(status.length > 0 ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  if (opts.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of formatRuns(org, result.runs, deps.now ?? Date.now())) log(line);
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
    const wf = r.workflowName ?? r.workflowId;
    lines.push(
      `  ${col(r.id, ID_W)}${col(wf, WF_W)}${col(r.status, STATUS_W)}${col(r.triggerKind ?? "—", TRIGGER_W)}${col(age(r.createdAt, now), AGE_W)}${duration(r.runtimeSeconds)}`,
    );
  }
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
