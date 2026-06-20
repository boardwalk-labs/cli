// SPDX-License-Identifier: MIT

// Determinism warnings for a workflow program, printed by the commands that accept one (check,
// build, dev, deploy, run). The analysis is the SHARED SDK lint (`@boardwalk-labs/workflow/lint`),
// so the CLI, the engines, and the hosted deploy all flag the same thing. Advisory: a warning never
// fails the command — a Boardwalk run restarts-from-the-top on crash and replays-from-the-top on
// resume, so any nondeterministic call OUTSIDE a journaled seam (step.run / agent) can silently
// produce a different value the second time. The fix is to wrap it in step.run / move it behind agent.

import { lintDeterminism } from "@boardwalk-labs/workflow/lint";

/** Print determinism warnings for `source` (no-op when clean). Never throws. */
export function reportDeterminism(
  source: string,
  fileName: string,
  log: (line: string) => void,
): void {
  const warnings = lintDeterminism(source, { fileName });
  if (warnings.length === 0) return;
  const n = warnings.length;
  log(`⚠ ${String(n)} determinism warning${n === 1 ? "" : "s"} (advisory — they don't block):`);
  for (const w of warnings) {
    log(`  ${fileName}:${String(w.line)}:${String(w.column)}  ${w.message}`);
  }
}
