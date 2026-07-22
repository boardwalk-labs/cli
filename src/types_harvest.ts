// SPDX-License-Identifier: MIT

// The TypeScript TYPES HARVEST — the machine layer of the two-layer artifact.
//
// The redesign's backend derivation sandbox resolves a workflow's `run` signature FULLY OFFLINE
// (no package install, ever — registry state at deploy time must not influence the schema). That
// works because `boardwalk build` runs where dependencies are actually installed, so it can pack
// exactly what the compiler needs to resolve types — and nothing else:
//
//   1. every declaration file under `node_modules` (`*.d.ts` / `*.d.mts` / `*.d.cts`),
//   2. every `package.json` under `node_modules` (for `types` / `exports` resolution),
//   3. the project root `package.json` (for `type` / `imports` (`#…` subpath) resolution),
//   4. the project's effective tsconfig: `tsconfig.json` plus its whole `extends` chain,
//      wherever a link in the chain lives inside the project root (incl. node_modules presets).
//
// The sandbox then derives against exactly the type versions the author compiled with — no
// install, no drift, no network. A package that ships no `.d.ts` simply isn't in the harvest and
// degrades honestly at derivation time (raw field + warning), per the fail-soft bias.
//
// Path safety mirrors the backend's spirit: every symlink is resolved once; a link whose target
// escapes the project root is SKIPPED (never followed), and directory-symlink cycles terminate
// via a walk-stack of resolved real paths. Symlinked trees that stay inside the root (pnpm's
// `node_modules/<pkg>` → `.pnpm/…` layout) are materialized at the link path so module resolution
// over the unpacked harvest works without symlink support. Nested/duplicated `node_modules`
// copies are kept as-is — correctness first; dedupe is a later optimization.
//
// Pure filesystem reads; no program execution, no network. Deterministic: entries are walked in
// sorted order and the result list is sorted by path.

import { readdirSync, realpathSync, statSync, existsSync, readFileSync, type Stats } from "node:fs";
import { join, dirname, posix, resolve, sep, isAbsolute } from "node:path";
import { isRecord } from "./guards.js";

/** One harvested file, at its project-root-relative POSIX path. */
export interface HarvestFile {
  /** POSIX path relative to the project root, e.g. `node_modules/@types/node/fs.d.ts`. */
  relPath: string;
  /** Absolute path on disk to read the bytes from. */
  absPath: string;
  /** Byte size on disk. */
  size: number;
}

/** The machine-layer file set for a project. */
export interface TypesHarvest {
  /** Deterministic: sorted by {@link HarvestFile.relPath}, no duplicates. */
  files: HarvestFile[];
  /** Sum of {@link HarvestFile.size} — the pre-compression harvest size. */
  totalBytes: number;
}

/** Declaration-file suffixes the harvest keeps (a `.d.ts.map` ends in `.map`, so it never matches). */
const DECLARATION_SUFFIXES = [".d.ts", ".d.mts", ".d.cts"] as const;

/** Directory names never descended into under node_modules. `.bin` holds executable shims, never
 *  types. (`.pnpm` and other dotdirs ARE walked — pnpm's real package trees live there.) */
const SKIP_DIR_NAMES = new Set([".bin"]);

/**
 * Harvest the machine layer from `projectRoot`: declaration files + package metadata under
 * `node_modules`, the root `package.json`, and the effective tsconfig chain. A project with no
 * `node_modules` (no deps) yields just the tsconfig/package.json — that's valid, not an error;
 * a project with neither yields an empty harvest.
 */
export function harvestTypes(projectRoot: string): TypesHarvest {
  const root = resolve(projectRoot);
  // The root itself may be reached through a symlink (common under tmpdirs); everything inside is
  // judged against its REAL path so the containment check is meaningful.
  const realRoot = realpathSync(root);
  const byRelPath = new Map<string, HarvestFile>();
  const add = (file: HarvestFile): void => {
    if (!byRelPath.has(file.relPath)) byRelPath.set(file.relPath, file);
  };

  const nodeModules = join(root, "node_modules");
  if (isDirectoryInsideRoot(nodeModules, realRoot)) {
    walkNodeModules(nodeModules, "node_modules", realRoot, [], add);
  }

  const rootPkg = join(root, "package.json");
  if (isFileInsideRoot(rootPkg, realRoot)) {
    add({ relPath: "package.json", absPath: rootPkg, size: statSync(rootPkg).size });
  }

  for (const abs of tsconfigChain(root, realRoot)) {
    const rel = toPosix(relativeInside(root, abs));
    if (rel !== null) add({ relPath: rel, absPath: abs, size: statSync(abs).size });
  }

  const files = [...byRelPath.values()].sort((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  );
  return { files, totalBytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/** True for a filename the node_modules walk keeps. */
function isHarvestFileName(name: string): boolean {
  if (name === "package.json") return true;
  return DECLARATION_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Walk a node_modules tree in sorted order, following in-root symlinks (materialized at the link
 * path) and skipping anything that escapes `realRoot`. `stack` carries the REAL paths of every
 * directory on the current descent, so a symlink cycle is cut the moment it would revisit one.
 */
function walkNodeModules(
  absDir: string,
  relDir: string,
  realRoot: string,
  stack: readonly string[],
  add: (file: HarvestFile) => void,
): void {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip, don't fail the build
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const ent of entries) {
    const abs = join(absDir, ent.name);
    const rel = `${relDir}/${ent.name}`;

    if (ent.isSymbolicLink()) {
      const real = tryRealpath(abs);
      if (real === null || !isInside(real, realRoot)) continue; // broken or escapes the root
      const st = tryStat(abs);
      if (st === null) continue;
      if (st.isDirectory()) {
        if (SKIP_DIR_NAMES.has(ent.name) || stack.includes(real)) continue; // shim dir / cycle
        walkNodeModules(abs, rel, realRoot, [...stack, real], add);
      } else if (st.isFile() && isHarvestFileName(ent.name)) {
        add({ relPath: rel, absPath: abs, size: st.size });
      }
      continue;
    }

    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      const real = tryRealpath(abs);
      if (real === null) continue;
      walkNodeModules(abs, rel, realRoot, [...stack, real], add);
    } else if (ent.isFile() && isHarvestFileName(ent.name)) {
      const st = tryStat(abs);
      if (st !== null) add({ relPath: rel, absPath: abs, size: st.size });
    }
  }
}

/**
 * The effective tsconfig chain: `<root>/tsconfig.json` plus every config it (transitively)
 * `extends`, keeping only links that live inside the project root (a chain member outside the
 * root — e.g. a preset in a global dir — is skipped; the sandbox degrades honestly without it).
 * Returns absolute paths; empty when the project has no tsconfig.
 */
export function tsconfigChain(projectRoot: string, realRoot?: string): string[] {
  const root = resolve(projectRoot);
  const realRootPath = realRoot ?? realpathSync(root);
  const start = join(root, "tsconfig.json");
  if (!isFileInsideRoot(start, realRootPath)) return [];

  const out: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const configPath = queue.shift();
    if (configPath === undefined) break;
    const real = tryRealpath(configPath);
    if (real === null || visited.has(real) || !isInside(real, realRootPath)) continue;
    visited.add(real);
    out.push(configPath);

    for (const target of readExtends(configPath)) {
      const resolved = resolveExtendsTarget(target, dirname(configPath), root);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return out;
}

/** Read a tsconfig's `extends` values (string or array; tsconfig is JSONC). Empty on any parse
 *  failure — the config file itself still ships; only chain-following is best-effort. */
function readExtends(configPath: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(configPath, "utf8")));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const ext = parsed.extends;
  if (typeof ext === "string") return [ext];
  if (Array.isArray(ext)) return ext.filter((e): e is string => typeof e === "string");
  return [];
}

/**
 * Resolve one `extends` target the way tsc does, simplified: a relative/absolute path resolves
 * against the extending config's directory (with `.json` appended if needed); a bare specifier
 * resolves into the PROJECT ROOT's node_modules (exact file, `+ .json`, or the package's
 * `tsconfig.json`). Null when nothing exists — the chain just ends there.
 */
function resolveExtendsTarget(target: string, fromDir: string, projectRoot: string): string | null {
  if (target.startsWith("./") || target.startsWith("../") || isAbsolute(target)) {
    return firstExistingFile([resolve(fromDir, target), `${resolve(fromDir, target)}.json`]);
  }
  const base = resolve(projectRoot, "node_modules", target);
  return firstExistingFile([base, `${base}.json`, join(base, "tsconfig.json")]);
}

function firstExistingFile(candidates: readonly string[]): string | null {
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Strip `//` and `/* *​/` comments plus trailing commas from JSONC (tsconfig's dialect) so
 * `JSON.parse` can read it. String-aware: comment markers inside string literals are preserved.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== "") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text.charAt(i) !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text.charAt(i) === "*" && text.charAt(i + 1) === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Trailing commas: a comma followed only by whitespace and a closing bracket/brace.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// ----- path helpers -----

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function tryStat(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** True when `real` (an already-resolved real path) sits at or under `realRoot`. */
function isInside(real: string, realRoot: string): boolean {
  return real === realRoot || real.startsWith(realRoot + sep);
}

function isDirectoryInsideRoot(p: string, realRoot: string): boolean {
  if (!existsSync(p)) return false;
  const real = tryRealpath(p);
  if (real === null || !isInside(real, realRoot)) return false;
  return tryStat(p)?.isDirectory() === true;
}

function isFileInsideRoot(p: string, realRoot: string): boolean {
  if (!existsSync(p)) return false;
  const real = tryRealpath(p);
  if (real === null || !isInside(real, realRoot)) return false;
  return tryStat(p)?.isFile() === true;
}

/** `abs` relative to `root` as a native path, or null when it doesn't sit strictly under the root. */
function relativeInside(root: string, abs: string): string | null {
  const prefix = root + sep;
  return abs.startsWith(prefix) ? abs.slice(prefix.length) : null;
}

function toPosix(p: string | null): string | null {
  return p === null ? null : p.split(sep).join(posix.sep);
}
