// SPDX-License-Identifier: MIT

// Runtime gate for commands that run a LOCAL engine (`dev`, `runner`). Those hand the run to
// @boardwalk-labs/engine, which spawns a child process PER RUN — something the single-file Bun
// executable can't do yet (a child needs a runtime + the engine entry on disk; both are embedded).
// So under Bun we fail fast with a clear pointer to the Node build instead of crashing deep in the
// engine's child spawn. The control-plane commands (deploy, run, runs, secrets, …) are unaffected.

import { CliError } from "./errors.js";

/** True when running under the Bun runtime — the compiled single-file executable, or `bun run`. */
export function isBunRuntime(): boolean {
  return typeof Bun !== "undefined";
}

/** Fail fast if a local-engine command is invoked under Bun (see the module note). */
export function assertNodeRuntime(command: string): void {
  if (!isBunRuntime()) return;
  throw new CliError(
    `\`boardwalk ${command}\` needs the Node build of the CLI.`,
    "This standalone binary covers the control-plane commands; local execution runs an engine that " +
      "spawns a process per run. Install the Node build: npm i -g @boardwalk-labs/cli",
  );
}
