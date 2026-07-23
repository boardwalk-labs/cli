// SPDX-License-Identifier: MIT

// The PYTHON build path — language detection + the dependency (machine) layer.
//
// A workflow package whose resolved entry is a `.py` file builds as Python (P5.4/P5.6 of the
// workflow-format redesign): no esbuild bundle, no TypeScript types harvest. The author layer is
// the package's `.py` source tree (under `.bw-src/`, same as TS) and the machine layer is a
// MATERIALIZED site-packages tree, resolved + frozen at BUILD time with `uv` — never installed on
// the run hot path, and never into the author's environment.
//
// Dependency declaration (either form; `pyproject.toml` preferred when both exist):
//   - `pyproject.toml` with `[project].dependencies` — `uv lock` generates/refreshes `uv.lock` in
//     the project (the reproducibility anchor, committed like a JS lockfile and shipped with the
//     sources), `uv export --frozen` pins the set, `uv pip install --target <tmp>` materializes it.
//   - `requirements.txt` — `uv pip install --target <tmp> -r requirements.txt` resolves and
//     materializes in one step; the materialized layer itself is the freeze (pip convention has no
//     project lockfile to refresh).
//
// The install always targets the HOSTED RUNNER's platform, not the build machine's: the fleet
// microVMs are x86_64 Linux (nested virt is Intel-only — docs/FIRECRACKER_RUNNER.md) running the
// base image's CPython 3.13 (P5.3). Pure-Python wheels are platform-independent; a package that
// needs a native build for another platform is the "custom runner image" case, exactly the TS rule.
//
// Byte-compiling (.pyc) is explicitly SKIPPED for now (`--no-compile-bytecode`): whether shipping
// pre-compiled bytecode wins on microVM cold-start is a still-open benchmark — decide there, not
// here.
//
// No dependencies declared → no machine layer, and `uv` is never required or invoked. `uv` missing
// when the package DOES need resolution → a clear error naming the install command.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";
import { CliError } from "./errors.js";

/** The program language, decided by the resolved entry's extension. */
export type WorkflowLanguage = "typescript" | "python";

/** CPython version baked into the hosted runner base image (P5.3) — what the install resolves for. */
export const PY_TARGET_VERSION = "3.13";
/** The hosted fleet's microVM platform (x86_64 Linux — nested virt is Intel-only). */
export const PY_TARGET_PLATFORM = "x86_64-unknown-linux-gnu";

const UV_INSTALL_HINT =
  "Install uv (the Python package manager the build uses to resolve + freeze dependencies): " +
  "`curl -LsSf https://astral.sh/uv/install.sh | sh` or `brew install uv` — https://docs.astral.sh/uv/";

/** `.py` entry ⇒ Python; anything else builds through the TypeScript path. */
export function languageOfEntry(entryPath: string): WorkflowLanguage {
  return entryPath.toLowerCase().endsWith(".py") ? "python" : "typescript";
}

/** Where a Python package's dependencies are declared. */
export interface PythonDeps {
  /** `pyproject.toml` ([project].dependencies) or `requirements.txt`. pyproject wins when both exist. */
  source: "pyproject" | "requirements";
  /** The declared requirement specs (for summaries — resolution is uv's job, not ours). */
  specs: string[];
}

/**
 * Detect whether (and where) the package declares Python dependencies. Returns null when nothing
 * is declared — a valid package with no machine layer, buildable WITHOUT uv. A `pyproject.toml`
 * with an empty (or absent) `[project].dependencies` counts as no dependencies; dynamic
 * dependencies (`dynamic = ["dependencies"]`) are not supported — declare them statically.
 */
export function detectPythonDeps(rootDir: string): PythonDeps | null {
  const pyproject = join(rootDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    const specs = parsePyprojectDependencies(readFileSync(pyproject, "utf8"));
    return specs.length > 0 ? { source: "pyproject", specs } : null;
  }
  const requirements = join(rootDir, "requirements.txt");
  if (existsSync(requirements)) {
    const specs = parseRequirementSpecs(readFileSync(requirements, "utf8"));
    return specs.length > 0 ? { source: "requirements", specs } : null;
  }
  return null;
}

/**
 * Extract `[project].dependencies` from pyproject.toml text. A deliberately small TOML subset —
 * the `[project]` table up to the next table header, the `dependencies = [ … ]` array (possibly
 * multi-line), string-literal items, `#` comments — which covers what authors actually write.
 * Anything it can't see (dynamic deps, exotic TOML) simply reads as "no dependencies".
 */
export function parsePyprojectDependencies(text: string): string[] {
  // Slice out the [project] table: from its header to the next top-level table header.
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (/^\[project\]\s*(#.*)?$/.test(line)) {
      start = i + 1;
      continue;
    }
    if (start !== -1 && line.startsWith("[")) {
      end = i;
      break;
    }
  }
  if (start === -1) return [];
  const table = lines.slice(start, end).join("\n");

  const keyMatch = /(^|\n)\s*dependencies\s*=\s*\[/.exec(table);
  if (keyMatch === null) return [];
  const arrayFrom = table.slice(keyMatch.index + keyMatch[0].length);
  return scanTomlStringArray(arrayFrom);
}

/**
 * Collect string literals from TOML array body text until the closing `]` (quote- and
 * comment-aware, so `pydantic[email]>=2` and `# notes` inside the array parse correctly).
 */
function scanTomlStringArray(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const ch = body.charAt(i);
    if (ch === "]") break;
    if (ch === "#") {
      while (i < body.length && body.charAt(i) !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let literal = "";
      i++;
      while (i < body.length && body.charAt(i) !== quote) {
        if (quote === '"' && body.charAt(i) === "\\" && i + 1 < body.length) {
          literal += body.charAt(i + 1);
          i += 2;
          continue;
        }
        literal += body.charAt(i);
        i++;
      }
      i++; // closing quote
      if (literal.trim().length > 0) out.push(literal.trim());
      continue;
    }
    i++;
  }
  return out;
}

/** Non-blank, non-comment lines of a requirements.txt (backslash continuations folded). */
export function parseRequirementSpecs(text: string): string[] {
  return text
    .replace(/\s*\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** One materialized site-packages file, at its site-packages-relative POSIX path. */
export interface SitePackagesFile {
  relPath: string;
  absPath: string;
  size: number;
}

/** The materialized dependency layer. Call `cleanup()` after staging — the files live in a tmpdir. */
export interface MaterializedSitePackages {
  /** Deterministic: sorted by relPath. */
  files: SitePackagesFile[];
  totalBytes: number;
  cleanup: () => void;
}

/** Test seam for running `uv` — mirrors the `spawnSync` result shape the code branches on. */
export type UvRunner = (
  args: string[],
  cwd: string,
) => { status: number | null; stderr: string; error?: NodeJS.ErrnoException | undefined };

const realUvRunner: UvRunner = (args, cwd) => {
  const res = spawnSync("uv", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The types say `stderr: string`, but a spawn failure (ENOENT) leaves it null at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  return { status: res.status, stderr: res.stderr ?? "", error: res.error };
};

function runUv(uvRun: UvRunner, args: string[], cwd: string): void {
  const res = uvRun(args, cwd);
  if (res.error?.code === "ENOENT") {
    throw new CliError(
      "This Python workflow declares dependencies, and building them needs `uv` (not found on PATH).",
      UV_INSTALL_HINT,
    );
  }
  if (res.error !== undefined) {
    throw new CliError(`Running \`uv ${args.join(" ")}\` failed.`, res.error.message);
  }
  if (res.status !== 0) {
    const stderr = res.stderr.trim();
    throw new CliError(
      `\`uv ${args.join(" ")}\` failed${res.status === null ? "" : ` (exit ${String(res.status)})`}.`,
      stderr.length > 0 ? stderr : undefined,
    );
  }
}

/**
 * Resolve + freeze + materialize the package's dependencies into a temp site-packages tree (the
 * bytes the artifact stages under `.bw-machine/site-packages/`). Never touches the author's
 * environment; the ONLY project write is `uv.lock` (pyproject packages — the anchor that makes the
 * build reproducible). Throws a precise CliError when uv is missing or resolution fails.
 */
export function materializeSitePackages(
  rootDir: string,
  deps: PythonDeps,
  uvRun: UvRunner = realUvRunner,
): MaterializedSitePackages {
  const tmp = mkdtempSync(join(tmpdir(), "bw-py-"));
  const target = join(tmp, "site-packages");
  mkdirSync(target);
  try {
    let requirementsFile: string;
    if (deps.source === "pyproject") {
      // Lockfile-pinned: (re)freeze uv.lock in the project, then export the exact pinned set.
      runUv(uvRun, ["lock"], rootDir);
      requirementsFile = join(tmp, "requirements.txt");
      runUv(
        uvRun,
        [
          "export",
          "--frozen",
          "--no-emit-project",
          "--no-hashes",
          "--format",
          "requirements-txt",
          "-o",
          requirementsFile,
        ],
        rootDir,
      );
    } else {
      requirementsFile = join(rootDir, "requirements.txt");
    }
    runUv(
      uvRun,
      [
        "pip",
        "install",
        "--target",
        target,
        "--python-version",
        PY_TARGET_VERSION,
        "--python-platform",
        PY_TARGET_PLATFORM,
        // Skip .pyc for now — the microVM cold-start benchmark decides byte-compiling (see header).
        "--no-compile-bytecode",
        "-r",
        requirementsFile,
      ],
      rootDir,
    );

    const files = collectSitePackages(target);
    return {
      files,
      totalBytes: files.reduce((sum, f) => sum + f.size, 0),
      cleanup: () => {
        rmSync(tmp, { recursive: true, force: true });
      },
    };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Walk the installed target tree. Skipped: `__pycache__`/`*.pyc` (no byte-compiling yet) and the
 * top-level `bin/` (console-script shims whose shebangs embed the build machine's temp interpreter
 * path — useless on the runner AND non-deterministic bytes, which would break content-addressing).
 */
function collectSitePackages(targetRoot: string): SitePackagesFile[] {
  const out: SitePackagesFile[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      const rel = relative(targetRoot, abs).split(sep).join(posix.sep);
      if (ent.isDirectory()) {
        if (ent.name === "__pycache__" || rel === "bin") continue;
        walk(abs);
      } else if (ent.isFile()) {
        if (ent.name.endsWith(".pyc")) continue;
        out.push({ relPath: rel, absPath: abs, size: statSync(abs).size });
      }
    }
  };
  walk(targetRoot);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}
