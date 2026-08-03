// SPDX-License-Identifier: MIT

// `boardwalk run <workflow>` — run a DEPLOYED workflow. `<workflow>` is a slug or a workflow id.
//
// This command never touches the filesystem: no build, no deploy, no project link. Running is a
// control-plane operation, so it works from any directory on any machine with only a login — you do
// not need the source to run what's already deployed. Shipping code is `boardwalk deploy` (and
// `deploy --run` when you want both in one step).
//
// It triggers the run, polls to a terminal state, and prints the captured `output(...)` values from
// the run's stored event log (the same source `boardwalk runs <id> --logs` reads), so the happy path
// shows the result without a detour to the dashboard.

import { statSync } from "node:fs";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { BoardwalkClient, type RunSummary, type RunEventSnapshot } from "../client.js";
import { resolveErrLog, resolveLog } from "../log.js";
import { fetchCredentialOrgs, resolveDeployOrg } from "../deployment.js";
import { resolveWorkflowId } from "../workflow_ref.js";
import { formatOutputValue } from "../render/renderer.js";
import { age } from "../age.js";
import type { FetchLike } from "../auth/pkce.js";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Minimal client surface `pollToTerminal` needs — `BoardwalkClient` satisfies it. */
export interface RunReader {
  getRun(runId: string): Promise<RunSummary>;
}

export interface PollOptions {
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: string) => void;
  now?: () => number;
}

/** Poll a run until it reaches a terminal state (completed/failed/cancelled), or time out. */
export async function pollToTerminal(
  client: RunReader,
  runId: string,
  opts: PollOptions = {},
): Promise<RunSummary> {
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
        }, ms);
      }));
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? ((): number => Date.now());

  const start = now();
  let lastStatus = "";
  for (;;) {
    const run = await client.getRun(runId);
    if (run.status !== lastStatus) {
      opts.onStatus?.(run.status);
      lastStatus = run.status;
    }
    if (isTerminalStatus(run.status)) return run;
    if (now() - start > timeoutMs) {
      throw new CliError(
        `Run ${runId} did not finish within ${String(Math.round(timeoutMs / 1000))}s (still ${run.status}).`,
        "It may still be running — check the run in the dashboard.",
      );
    }
    await sleep(intervalMs);
  }
}

export interface RunOptions {
  /** The DEPLOYED workflow to run: its slug, or its id (a ULID, as in a dashboard URL). */
  workflow: string;
  org?: string | undefined;
  input?: string | undefined;
  /** Environment NAME to run in (omit = the org base). Selected here, not in the manifest. */
  environment?: string | undefined;
  token?: string | undefined;
  noWait?: boolean;
  /** Emit a single JSON object ({ runId, status, ... }) on stdout; route progress to stderr. */
  json?: boolean | undefined;
}

export interface RunDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  now?: number;
}

export async function runRun(opts: RunOptions, deps: RunDeps): Promise<void> {
  // In --json mode, human progress goes to stderr so stdout carries ONLY the JSON payload — a
  // script can `boardwalk run . --json | jq -r .runId` cleanly. `emit` writes the payload (still
  // through deps.log so tests capture it); `log` writes progress.
  const jsonMode = opts.json === true;
  const emit = resolveLog(deps);
  const log = jsonMode ? resolveErrLog(deps) : emit;

  assertNotAPath(opts.workflow);

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

  // The trigger endpoint is org-scoped, so an org is always required — resolved by the same
  // deterministic rule `deploy` uses, MINUS the project link: `run` reads nothing local, so where
  // you happen to be standing can never change which workflow you fire.
  const orgSlug = resolveDeployOrg({
    orgFlag: (opts.org ?? "").trim() || undefined,
    credentialOrgs: await fetchCredentialOrgs(client),
    linkOrg: null,
  });
  const workflowId = await resolveWorkflowId(client, orgSlug, opts.workflow);

  // Name the exact version being fired. Nothing here builds, so when you edited locally and forgot
  // to deploy, "deployed 2h ago" is the tell.
  const detail = await client.getWorkflowDetail(workflowId);
  log(`▶ ${detail.slug} · ${describeVersion(detail, deps.now ?? Date.now())}`);

  await triggerAndReport(client, {
    orgSlug,
    workflowId,
    input: parseInput(opts.input),
    environment: opts.environment,
    noWait: opts.noWait === true,
    jsonMode,
    log,
    emit,
  });
}

/**
 * `run` takes a DEPLOYED workflow, but `boardwalk run .` is the muscle memory (and what every older
 * doc says), so a path-shaped argument gets a redirect instead of "no workflow named '.'".
 */
function assertNotAPath(ref: string): void {
  const trimmed = ref.trim();
  const pathShaped =
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    existsOnDisk(trimmed);
  if (!pathShaped) return;
  throw new CliError(
    `\`run\` takes a deployed workflow (slug or id), not a path — "${trimmed}" looks like one.`,
    "Ship the code first, then run it by slug: `boardwalk deploy <dir>` → `boardwalk run <slug>`. To do both at once: `boardwalk deploy <dir> --run`.",
  );
}

function existsOnDisk(target: string): boolean {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

/** "version 7 · deployed 2h ago" — or just the version when the timestamp isn't available. */
export function describeVersion(
  detail: {
    currentVersionId: string | null;
    versions: { id: string; number: number; createdAt: number }[];
  },
  now: number,
): string {
  const current = detail.versions.find((v) => v.id === detail.currentVersionId);
  if (current === undefined) return "no deployed version";
  return `version ${String(current.number)} · deployed ${age(current.createdAt, now)} ago`;
}

/**
 * Trigger a run and report it: poll to terminal, print the captured outputs, and fail the process
 * when the run didn't complete. Shared by `run` and `deploy --run` so both report identically.
 */
export async function triggerAndReport(
  client: BoardwalkClient,
  args: {
    orgSlug: string;
    workflowId: string;
    input: unknown;
    environment?: string | undefined;
    noWait: boolean;
    jsonMode: boolean;
    log: (line: string) => void;
    emit: (line: string) => void;
  },
): Promise<void> {
  const { orgSlug, workflowId, input, environment, noWait, jsonMode, log, emit } = args;

  const run = await client.triggerRun(orgSlug, workflowId, input, environment);
  log(
    `▶ run ${run.id} triggered (${run.status})${environment !== undefined ? ` in ${environment}` : ""}`,
  );

  if (noWait) {
    log(`  --no-wait: not polling. Track it with \`boardwalk runs ${run.id}\`.`);
    if (jsonMode) emit(JSON.stringify({ runId: run.id, status: run.status }));
    return;
  }

  log(`  (cancel anytime: boardwalk cancel ${run.id})`);
  const terminal = await pollToTerminal(client, run.id, {
    onStatus: (status) => {
      log(`  status → ${status}`);
    },
  });
  // Best-effort: a flaky events read shouldn't sink an otherwise-successful run — the result
  // block still prints, just with the `--logs` pointer instead of the inline output.
  const outputs = await collectRunOutputs(client, run.id).catch(() => []);
  // A failed run's WHY is on the run detail — fetch it here so the result block answers it
  // inline instead of forcing a second command (same best-effort stance as the outputs read).
  const error =
    terminal.status === "completed"
      ? null
      : await client
          .getRunDetail(run.id)
          .then((detail) => detail.error)
          .catch(() => null);
  if (jsonMode) {
    emit(
      JSON.stringify({
        runId: terminal.id,
        status: terminal.status,
        outcome: terminal.outcomeStatus ?? null,
        ...(error !== null ? { error } : {}),
        outputs,
      }),
    );
  } else {
    printOutcome(log, terminal, outputs, error);
  }
  if (terminal.status !== "completed") {
    throw new CliError(
      `Run ${terminal.status}.`,
      `See the full log: boardwalk runs ${terminal.id} --logs`,
    );
  }
}

/** Pull every `output(...)` value from a run's stored event log, formatted as the `--logs` view
 *  renders them. Exported for tests; the client's `getRunEvents` satisfies the reader shape. */
export async function collectRunOutputs(
  client: { getRunEvents(runId: string): Promise<RunEventSnapshot> },
  runId: string,
): Promise<string[]> {
  const { events } = await client.getRunEvents(runId);
  const outputs: string[] = [];
  for (const { event } of events) {
    if (event.kind === "output") outputs.push(formatOutputValue(event.value));
  }
  return outputs;
}

/** Parse `--input '<json>'` to a value; undefined when absent. Throws on malformed JSON. */
export function parseInput(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError("--input is not valid JSON.");
  }
}

function printOutcome(
  log: (line: string) => void,
  run: RunSummary,
  outputs: string[],
  error: { code: string; message: string; hint?: string } | null,
): void {
  log("──────── run result ────────");
  log(`run:     ${run.id}`);
  log(`status:  ${run.status}`);
  // `outcome` is a reserved control-plane column nothing writes today — show it only if it
  // ever carries a value, never as a `(none)` line readers have to puzzle over.
  if (run.outcomeStatus !== null) log(`outcome: ${run.outcomeStatus}`);
  if (error !== null) {
    log(`error:   ${error.code}: ${error.message}`);
    if (error.hint !== undefined) log(`hint:    ${error.hint}`);
  }
  if (outputs.length === 0) {
    log("output:  (none)");
  } else {
    log("output:");
    for (const value of outputs) {
      for (const line of value.split("\n")) log(`  ${line}`);
    }
  }
  log(`logs:    boardwalk runs ${run.id} --logs`);
}
