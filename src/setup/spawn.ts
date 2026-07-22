// SPDX-License-Identifier: MIT

// Subprocess helpers for `boardwalk setup`: run an external installer (`claude plugin install`,
// `npx codex-plugin add`, …) and detect whether a command is on PATH. Kept tiny and injected into
// the setup command as `runCommand` / `commandExists`, so the command's tests never spawn a real
// process and never depend on which agents happen to be installed on the test machine.

import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface RunResult {
  /** Exit code, or 127 when the binary could not be spawned (ENOENT) — the caller treats non-zero
   *  as "this installer failed" without having to catch. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  /** Inherit the parent's stdio so an interactive installer can draw to the terminal and prompt.
   *  When false (detection probes), output is captured into the result and the child is silent. */
  inherit?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** The subprocess seam the setup command depends on — one function, injected so tests substitute it. */
export type RunCommand = (
  cmd: string,
  args: string[],
  opts?: RunCommandOptions,
) => Promise<RunResult>;

/**
 * Spawn `cmd args` and resolve with its exit code (plus captured output unless inheriting). NEVER
 * rejects: a spawn failure (missing binary) resolves as code 127 with the error on stderr, so the
 * wizard can report "couldn't run X" as a normal step outcome instead of a thrown stack.
 */
export const runCommand: RunCommand = (cmd, args, opts = {}) =>
  new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args, {
      stdio: opts.inherit === true ? "inherit" : "pipe",
      env: opts.env ?? process.env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      // Windows resolves `npx`/`claude` shims only through the shell.
      shell: platform() === "win32",
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    child.on("error", (err) => {
      resolve({ code: 127, stdout, stderr: stderr + (err instanceof Error ? err.message : "") });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });

/** True when `bin` resolves on PATH. Uses `which`/`where` so it never executes the target itself. */
export async function commandExists(bin: string, run: RunCommand = runCommand): Promise<boolean> {
  const probe = platform() === "win32" ? "where" : "which";
  const { code } = await run(probe, [bin], { inherit: false });
  return code === 0;
}
