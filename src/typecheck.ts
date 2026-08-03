// SPDX-License-Identifier: MIT

// Local TypeScript typechecking for `check` and `deploy` — the author's OWN tsc, run against
// the package's tsconfig. esbuild bundling is strip-only, so without this a type error (a
// malformed `sleep()` arg, a misspelled option) sails through to a runtime failure on the
// platform, costing a deploy+run cycle to discover.
//
// Fail-soft by design: no `typescript` resolvable from the package (or no tsconfig) → a
// one-line note, never a block — the platform never REQUIRES tsc. When tsc runs and finds
// errors, that fails the command (that is the point). Python packages never reach here.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { CliError } from "./errors.js";

/** Test seam: run the resolved tsc entry under the current Node. */
export type TscRunner = (
  tscPath: string,
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr: string };

export const realTscRunner: TscRunner = (tscPath, args, cwd) => {
  const res = spawnSync(process.execPath, [tscPath, ...args], { cwd, encoding: "utf8" });
  // On spawn failure stdout/stderr are null (despite the string typing) — surface the error.
  if (res.error !== undefined) return { status: null, stdout: "", stderr: res.error.message };
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

export interface TypecheckOutcome {
  /** True when tsc actually ran (and passed — errors throw instead). */
  ran: boolean;
  /** The one-line skip reason when it didn't. */
  note?: string;
}

/**
 * Typecheck the package at `dir` with its own TypeScript, throwing a `CliError` carrying tsc's
 * diagnostics when the package has type errors.
 */
export function typecheckPackage(dir: string, runner: TscRunner = realTscRunner): TypecheckOutcome {
  const tsconfig = path.join(dir, "tsconfig.json");
  if (!existsSync(tsconfig)) {
    return { ran: false, note: "not checked (no tsconfig.json in the package)" };
  }
  let tscPath: string;
  try {
    tscPath = createRequire(path.join(dir, "package.json")).resolve("typescript/lib/tsc.js");
  } catch {
    return {
      ran: false,
      note: "not checked — add `typescript` to devDependencies to catch type errors before a run",
    };
  }
  const res = runner(tscPath, ["--noEmit", "--pretty", "false", "-p", tsconfig], dir);
  if (res.status === 0) return { ran: true };
  const diagnostics = `${res.stdout}\n${res.stderr}`.trim();
  throw new CliError(
    "The package has type errors (tsc --noEmit).",
    diagnostics === ""
      ? "tsc exited non-zero with no output."
      : `${diagnostics.slice(0, 4000)}\n  Fix them, or pass --no-typecheck to ship anyway.`,
  );
}
