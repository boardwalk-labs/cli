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
import { resolveApiTarget } from "../auth/resolve.js";
import { resolveLog } from "../log.js";
import { BoardwalkClient, isTerminalStatus, type RunListItem, type RunDetail } from "../client.js";
import { readLink } from "../project.js";
import { resolveWorkflowId } from "../workflow_ref.js";
import {
  createJsonLineRenderer,
  createRenderer,
  parseChannels,
  type EventRenderer,
} from "../render/renderer.js";
import type { FetchLike } from "../auth/pkce.js";

export interface RunsOptions {
  /** When set, act on this single run (detail / --logs / --follow); no --org needed. */
  runId?: string | undefined;
  org?: string | undefined;
  /** Filter the LIST to one workflow (id or slug). */
  workflow?: string | undefined;
  status?: string | undefined;
  limit?: string | undefined;
  json?: boolean | undefined;
  /** Print the run's event log (one-shot snapshot) instead of its summary. */
  logs?: boolean | undefined;
  /** Live-tail the run's events over SSE until it finishes. */
  follow?: boolean | undefined;
  /** Event channels for --logs/--follow: --verbose = all; --stream = an explicit list. */
  verbose?: boolean | undefined;
  stream?: string | undefined;
  /** With --logs/--follow: emit every event as one line of NDJSON (all channels, no ANSI). */
  jsonStream?: boolean | undefined;
  token?: string | undefined;
}

export interface RunsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Raw writer for streamed event text (no added newline) — defaults to process.stdout.write. */
  write?: (text: string) => void;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
  /** Wall-clock used to render ages (defaults to Date.now()). */
  now?: number;
  /** Abort signal for --follow (e.g. wired to SIGINT by the entrypoint). */
  signal?: AbortSignal;
  /** Backoff between --follow reconnects (injectable for tests; defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
}

/** Max --follow reconnects after the stream closes while the run is still going (then we bail with a hint). */
const MAX_FOLLOW_RECONNECTS = 5;
const FOLLOW_RECONNECT_MS = 1_000;

/** Map a 404 from a single-run fetch to a friendly "no such run" error; re-throw anything else.
 *  Without this the raw `GET /v1/runs/<id> failed (404)` leaks (cf. the friendly `workflows show`). */
function runNotFound(runId: string, err: unknown): never {
  if (err instanceof CliError && err.status === 404) {
    throw new CliError(`No run "${runId}" found.`, "Check the id with `boardwalk runs`.");
  }
  throw err instanceof Error ? err : new CliError(String(err));
}

export async function runRuns(opts: RunsOptions, deps: RunsDeps): Promise<void> {
  const log = resolveLog(deps);
  const write =
    deps.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });

  const runId = (opts.runId ?? "").trim();
  const now = deps.now ?? Date.now();

  if (opts.logs === true && opts.follow === true) {
    throw new CliError("Use either --logs or --follow, not both.");
  }
  if ((opts.logs === true || opts.follow === true) && runId.length === 0) {
    throw new CliError("--logs / --follow need a run id.", "Usage: boardwalk runs <runId> --logs");
  }

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

  // ── single-run modes — the endpoint resolves the org from the run id, so no --org is needed ──
  if (runId.length > 0) {
    if (opts.follow === true) {
      await followRunEvents(client, runId, eventRenderer(opts, write), write, deps);
      return;
    }
    if (opts.logs === true) {
      const renderer = eventRenderer(opts, write);
      const snapshot = await client
        .getRunEvents(runId)
        .catch((e: unknown) => runNotFound(runId, e));
      for (const row of snapshot.events) renderer.render(row.event);
      return;
    }
    const run = await client.getRunDetail(runId).catch((e: unknown) => runNotFound(runId, e));
    if (opts.json === true) {
      log(JSON.stringify(run, null, 2));
      return;
    }
    for (const line of formatRunDetail(run, now)) log(line);
    return;
  }

  // ── list mode — needs an org (from --org or the linked project) ──
  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const limit = parseLimit(opts.limit);
  const status = (opts.status ?? "").trim();
  const listOpts = {
    ...(status.length > 0 ? { status } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };

  // --workflow scopes the list to one workflow (id or slug, resolved against the org).
  const workflowRef = (opts.workflow ?? "").trim();
  const result =
    workflowRef.length > 0
      ? await client.listWorkflowRuns(
          org,
          await resolveWorkflowId(client, org, workflowRef),
          listOpts,
        )
      : await client.listOrgRuns(org, listOpts);

  if (opts.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  const heading = workflowRef.length > 0 ? `${org} / ${workflowRef}` : org;
  for (const line of formatRuns(heading, result.runs, now)) log(line);
  if (result.nextCursor !== null) {
    log("");
    log("  More runs available — raise --limit or filter with --status.");
  }
}

/** Build the event renderer for --logs/--follow: NDJSON with --json-stream, else the channel-filtered
 *  human view (default channels: lifecycle+phase+output). */
function eventRenderer(opts: RunsOptions, write: (text: string) => void): EventRenderer {
  if (opts.jsonStream === true) return createJsonLineRenderer(write);
  const channels = parseChannels({ verbose: opts.verbose ?? false, stream: opts.stream });
  return createRenderer(channels, write);
}

/**
 * Live-tail a run: stream events, rendering each, until the run is terminal. The worker may close
 * the SSE stream WITHOUT a terminal `run_status` frame, so when the stream ends we confirm via the
 * events snapshot (`done`) — draining any tail it carries — and only reconnect (from the last
 * cursor) if the run is genuinely still going.
 */
async function followRunEvents(
  client: BoardwalkClient,
  runId: string,
  renderer: EventRenderer,
  write: (text: string) => void,
  deps: RunsDeps,
): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let cursor = 0;
  let reconnects = 0;

  for (;;) {
    const streamOpts: { fromCursor?: number; signal?: AbortSignal } = {};
    if (cursor > 0) streamOpts.fromCursor = cursor;
    if (deps.signal !== undefined) streamOpts.signal = deps.signal;

    for await (const row of client.streamRunEvents(runId, streamOpts)) {
      if (row.cursor > cursor) cursor = row.cursor;
      renderer.render(row.event);
      if (row.event.kind === "run_status" && isTerminalStatus(row.event.status)) return;
    }
    if (deps.signal?.aborted === true) return;

    // Stream closed. Confirm terminal via the snapshot (and render any tail it has beyond `cursor`).
    const snapshot = await client.getRunEvents(runId, cursor);
    for (const row of snapshot.events) {
      if (row.cursor > cursor) cursor = row.cursor;
      renderer.render(row.event);
    }
    if (snapshot.done) return;

    if (++reconnects > MAX_FOLLOW_RECONNECTS) {
      write(
        `\n· stream ended while run ${runId} was still active — re-run \`boardwalk runs ${runId} --follow\` to resume.\n`,
      );
      return;
    }
    await sleep(FOLLOW_RECONNECT_MS);
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
    // Cache-served input rides the token line: it's a SUBSET of `in`, so showing it as a share of
    // input answers "am I paying full price for this prompt?" without a second line.
    const cached = run.cachedTokensIn ?? 0;
    const cacheNote =
      cached > 0 && run.tokensIn > 0
        ? `, ${String(Math.round((cached / run.tokensIn) * 100))}% cached`
        : "";
    lines.push(
      field(
        "Tokens",
        `${compact(tokens)}  (${compact(run.tokensIn)} in${cacheNote} · ${compact(run.tokensOut)} out)`,
      ),
    );
  }
  // The run's real recorded spend. Omitted entirely when the server doesn't report it (older
  // deployments) — never shown as "$0.00" for "unknown".
  if (run.costUsd !== undefined && run.costUsd !== null) {
    lines.push(field("Spend", formatUsd(run.costUsd)));
  }
  if (run.error !== null) lines.push(field("Error", `${run.error.code}: ${run.error.message}`));
  return lines;
}

/** Money for humans: sub-cent spend gets 4 dp so a cheap run isn't rendered as "$0.00". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
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
