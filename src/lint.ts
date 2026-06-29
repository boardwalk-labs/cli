// SPDX-License-Identifier: MIT

// Determinism warnings for a workflow program. The analysis is the SHARED SDK lint
// (`@boardwalk-labs/workflow/lint`), so the CLI, the engines, and the hosted deploy all flag the
// same thing. A Boardwalk run restarts-from-the-top on crash and replays-from-the-top on resume, so
// any nondeterministic call OUTSIDE a journaled seam (now/random/uuid, step.run, agent) can silently
// produce a different value the second time and corrupt the run.
//
// Two entry points: `reportDeterminism` PRINTS warnings and returns the count (build + dev use it,
// advisory everywhere); `enforceDeterminism` additionally THROWS when a BLOCKING warning remains
// (deploy + run + check use it — the gate), unless the caller passes `allow`.
//
// What blocks vs. what's advisory: the clock/random/uuid family has a one-token durable replacement
// (now() / random() / uuid()) and essentially no legitimate bare use in a durable workflow, so it
// blocks — pure upside. Bare `fetch` (and other raw I/O) is the legitimate backbone of a simple
// script, and the durable fix (step.run) is a real refactor, so it stays advisory and deploys: the
// "ordinary TypeScript, any fetch" promise holds for non-suspending programs (docs/SUSPENSION.md §10).
// Follow-up once the CLI is on SDK ≥ 0.1.17: block `fetch` too WHEN the program can suspend (a
// fetch before a `sleep` re-fires on resume), using a suspend-seam detector the SDK exposes (it
// needs the TypeScript AST, which is only a runtime dep inside the SDK).

import { lintDeterminism, type DeterminismWarning } from "@boardwalk-labs/workflow/lint";
import { CliError } from "./errors.js";

/**
 * Symbols the gate BLOCKS on: the clock/random/uuid family, each a one-token swap to now() / random()
 * / uuid(). Everything else the lint flags (notably `fetch`) is advisory — printed, never blocking.
 */
const BLOCKING_SYMBOLS: ReadonlySet<string> = new Set([
  "Date.now",
  "new Date()",
  "performance.now",
  "Math.random",
  "crypto.randomUUID",
  "crypto.getRandomValues",
  "randomUUID",
]);

function printWarnings(
  warnings: readonly DeterminismWarning[],
  fileName: string,
  log: (l: string) => void,
): void {
  const n = warnings.length;
  log(`⚠ ${String(n)} determinism warning${n === 1 ? "" : "s"}:`);
  for (const w of warnings) {
    log(`  ${fileName}:${String(w.line)}:${String(w.column)}  ${w.message}`);
  }
}

/** Print determinism warnings for `source`; return how many there were (0 = clean). Never throws. */
export function reportDeterminism(
  source: string,
  fileName: string,
  log: (line: string) => void,
): number {
  const warnings = lintDeterminism(source, { fileName });
  if (warnings.length === 0) return 0;
  printWarnings(warnings, fileName, log);
  return warnings.length;
}

/**
 * Gate a workflow on determinism: print every warning, then THROW a `CliError` if a BLOCKING one
 * remains — unless `allow` is set, in which case it prints a note and proceeds. Advisory-only
 * warnings (e.g. `fetch`) print but never block. Used by the commands that ship or validate a
 * workflow (deploy / run / check).
 */
export function enforceDeterminism(
  source: string,
  fileName: string,
  log: (line: string) => void,
  allow: boolean,
): void {
  const warnings = lintDeterminism(source, { fileName });
  if (warnings.length === 0) return;
  printWarnings(warnings, fileName, log);

  const blocking = warnings.filter((w) => BLOCKING_SYMBOLS.has(w.symbol));
  if (blocking.length === 0) return; // only advisory warnings (e.g. fetch) — don't block
  if (allow) {
    log("  proceeding anyway (--allow-nondeterminism)");
    return;
  }
  const k = blocking.length;
  throw new CliError(
    `${String(k)} determinism issue${k === 1 ? "" : "s"} would corrupt this workflow's state on a resume or crash.`,
    "Fix them — use now() / random() / uuid() instead of bare Date.now() / Math.random() / crypto.randomUUID() — or pass --allow-nondeterminism to override.",
  );
}
