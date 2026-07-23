// SPDX-License-Identifier: MIT

// The workflow DESCRIPTOR — locating and validating `workflow.jsonc` / `workflow.json`.
//
// The new-format package is two files: a `run` function (`src/index.ts`, or the descriptor's
// `entry`) and a small declarative descriptor at the project root. The descriptor is the
// control-plane contract (slug, triggers, permissions, budget, …) — everything EXCEPT the I/O
// schemas, which the backend derives from the function signature at deploy. Parsing + validation
// is the SDK's `parseWorkflowDescriptor` (JSONC parse → manifest schema minus the derived
// `input_schema`/`output_schema` → concurrency-key template syntax check), so the CLI enforces
// exactly the schema every engine consumes; this module just locates the file and translates
// failures into actionable `CliError`s.
//
// Pure logic + filesystem reads; the program is never executed.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  DescriptorValidationError,
  parseWorkflowDescriptor,
  type WorkflowDescriptor,
} from "@boardwalk-labs/workflow";
import { CliError } from "./errors.js";

/** The two accepted descriptor filenames — comments allowed vs. strict JSON. Having both is an error. */
export const DESCRIPTOR_NAMES = ["workflow.jsonc", "workflow.json"] as const;

/** Default entry candidates when the descriptor names no `entry` (the `src/index.ts` convention).
 *  Python's default, `main.py` at the package root, is tried after these — a `.py` resolved entry
 *  is what routes the build down the Python path (no bundle, no types harvest). */
const DEFAULT_ENTRIES = ["src/index.ts", "src/index.mts", "src/index.js", "src/index.mjs"] as const;
const DEFAULT_PYTHON_ENTRY = "main.py";

const FORMAT_HINT =
  "A workflow package is a directory with a `workflow.jsonc` descriptor at its root and a " +
  "`src/index.ts` exporting a default `run` function. Scaffold one with `boardwalk init`.";

/** A located, parsed, schema-validated descriptor plus the verbatim bytes that ship at the artifact root. */
export interface LoadedDescriptor {
  descriptor: WorkflowDescriptor;
  /** Absolute path of the descriptor file on disk. */
  absPath: string;
  /** `workflow.jsonc` or `workflow.json` — the name it keeps inside the artifact. */
  fileName: string;
  /** The raw descriptor text, shipped VERBATIM (comments are author-facing, never stored parsed). */
  raw: string;
}

/**
 * Resolve a CLI target to the workflow package root: a directory is the root itself; a path to the
 * descriptor file resolves to its directory. Anything else (a lone program file, a missing path) is
 * an error — the new format has no descriptor-less deploy.
 */
export function resolveProjectRoot(target: string): string {
  const abs = resolve(target);
  let isDir: boolean;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    throw new CliError(`Path not found: ${target}`);
  }
  if (isDir) return abs;
  if (DESCRIPTOR_NAMES.some((name) => name === basename(abs))) return dirname(abs);
  throw new CliError(`Not a workflow package: ${target}`, FORMAT_HINT);
}

/**
 * Locate + parse + validate the package's descriptor. Exactly one of `workflow.jsonc` /
 * `workflow.json` must exist at the package root — both is ambiguous (error), neither means the
 * directory isn't a workflow package (error).
 */
export function loadDescriptor(rootDir: string): LoadedDescriptor {
  const present = DESCRIPTOR_NAMES.filter((name) => existsSync(join(rootDir, name)));
  const fileName = present[0];
  if (fileName === undefined) {
    throw new CliError(`No workflow.jsonc (or workflow.json) found in ${rootDir}.`, FORMAT_HINT);
  }
  if (present.length > 1) {
    throw new CliError(
      `Both workflow.jsonc AND workflow.json exist in ${rootDir}.`,
      "Keep exactly one descriptor — delete the other.",
    );
  }

  const absPath = join(rootDir, fileName);
  const raw = readFileSync(absPath, "utf8");
  try {
    return { descriptor: parseWorkflowDescriptor(raw), absPath, fileName, raw };
  } catch (err) {
    if (err instanceof DescriptorValidationError) {
      throw new CliError(`${fileName}: ${err.message}`);
    }
    if (err instanceof SyntaxError) {
      throw new CliError(
        `${fileName} is not valid JSON${fileName.endsWith("c") ? "C" : ""}.`,
        err.message,
      );
    }
    throw err;
  }
}

/**
 * Resolve the program entry: the descriptor's `entry` (validated to exist and stay inside the
 * package), else the `src/index.*` convention. Returns the absolute path.
 */
export function resolveRunEntry(rootDir: string, descriptor: WorkflowDescriptor): string {
  const declared = descriptor.entry;
  if (declared !== undefined) {
    const abs = resolve(rootDir, declared);
    if (abs !== rootDir && !abs.startsWith(rootDir + sep)) {
      throw new CliError(
        `The descriptor's entry escapes the package: ${declared}`,
        "`entry` must point inside the workflow directory.",
      );
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new CliError(`The descriptor's entry does not exist: ${declared}`);
    }
    return abs;
  }
  for (const candidate of [...DEFAULT_ENTRIES, DEFAULT_PYTHON_ENTRY]) {
    const abs = join(rootDir, candidate);
    if (existsSync(abs)) return abs;
  }
  throw new CliError(
    `No entry found in ${rootDir}.`,
    `Add a src/index.ts exporting a default run function (or a main.py for Python), or set "entry" in workflow.jsonc.`,
  );
}
