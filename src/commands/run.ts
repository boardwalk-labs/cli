// SPDX-License-Identifier: MIT

// `boardwalk run <file|dir> --org <slug>` — actually run a workflow, for real.
//
// Runs on the PLATFORM (where the real worker + real inference live — no mocks): it deploys the
// current source (via the project link), triggers a run, polls it to a terminal state, and prints
// the captured `output(...)` values — fetched from the run's stored event log (the same source
// `boardwalk runs <id> --logs` reads), so the happy path shows the result without a detour to the
// dashboard.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { BoardwalkClient, type RunSummary, type RunEventSnapshot } from "../client.js";
import { resolveErrLog, resolveLog } from "../log.js";
import { deployWithLink, loadProgram } from "../deployment.js";
import { logDeployWarnings, makeCreateConfirmer } from "./deploy.js";
import { formatOutputValue } from "../render/renderer.js";
import type { FetchLike } from "../auth/pkce.js";
import type { Prompter } from "../prompt.js";

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
  file: string;
  org?: string | undefined;
  input?: string | undefined;
  /** Environment NAME to run in (omit = the org base). Selected here, not in the manifest. */
  environment?: string | undefined;
  token?: string | undefined;
  noWait?: boolean;
  /** Skip the interactive create confirmation when the deploy would CREATE a new workflow (CI). */
  yes?: boolean | undefined;
  /** Emit a single JSON object ({ runId, status, ... }) on stdout; route progress to stderr. */
  json?: boolean | undefined;
}

export interface RunDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Injected in tests; defaults to the real terminal prompter. */
  prompter?: Prompter;
  /** Whether stdin can prompt (defaults to the real TTY state). */
  interactive?: boolean;
}

export async function runRun(opts: RunOptions, deps: RunDeps): Promise<void> {
  // In --json mode, human progress goes to stderr so stdout carries ONLY the JSON payload — a
  // script can `boardwalk run . --json | jq -r .runId` cleanly. `emit` writes the payload (still
  // through deps.log so tests capture it); `log` writes progress.
  const jsonMode = opts.json === true;
  const emit = resolveLog(deps);
  const log = jsonMode ? resolveErrLog(deps) : emit;

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

  const dep = await deployWithLink(client, {
    orgSlug: opts.org,
    target: opts.file,
    prog,
    confirmCreate: makeCreateConfirmer({
      yes: opts.yes === true,
      interactive: deps.interactive ?? process.stdin.isTTY,
      prompter: deps.prompter,
    }),
  });
  if (dep.gitignoreUpdated)
    log("  linked → .boardwalk/project.json (added .boardwalk/ to .gitignore)");
  // Log the slug we ACTUALLY deployed to (not the descriptor's), so the run is never mislabeled.
  if (dep.ignoredFileSlug !== undefined)
    log(
      `⚠ this directory is linked to workflow "${dep.deployedSlug}" — the descriptor's slug "${dep.ignoredFileSlug}" was ignored (deployed as a new version of "${dep.deployedSlug}"). Run a different workflow from its own directory, or delete .boardwalk/ to re-link.`,
    );
  log(`✓ ${dep.outcome} "${dep.deployedSlug}" version ${String(dep.versionNumber)}`);
  logDeployWarnings(log, dep.warnings);

  const input = parseInput(opts.input);
  const run = await client.triggerRun(dep.orgSlug, dep.workflowId, input, opts.environment);
  log(
    `▶ run ${run.id} triggered (${run.status})${opts.environment !== undefined ? ` in ${opts.environment}` : ""}`,
  );

  if (opts.noWait === true) {
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
  if (jsonMode) {
    emit(
      JSON.stringify({
        runId: terminal.id,
        status: terminal.status,
        outcome: terminal.outcomeStatus ?? null,
        outputs,
      }),
    );
  } else {
    printOutcome(log, terminal, outputs);
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

function printOutcome(log: (line: string) => void, run: RunSummary, outputs: string[]): void {
  log("──────── run result ────────");
  log(`run:     ${run.id}`);
  log(`status:  ${run.status}`);
  log(`outcome: ${run.outcomeStatus ?? "(none)"}`);
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
