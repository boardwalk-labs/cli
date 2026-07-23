// SPDX-License-Identifier: MIT

// Build a deploy ARTIFACT — the frozen, content-addressed program the runner executes.
//
// The packaging model (workflow-format redesign): a workflow package is a `run` function plus a
// `workflow.jsonc` descriptor. `buildArtifact` validates the descriptor, esbuild-bundles the entry
// into one `index.mjs` (+ external sourcemap, `@boardwalk-labs/workflow` left external — the host
// layer), and packs a DETERMINISTIC `tar.gz` of:
//
//   index.mjs / index.mjs.map    — what the runner executes
//   workflow.jsonc|.json         — the descriptor, VERBATIM at the artifact root (the control-plane
//                                  contract; the backend reads it as data, comments stripped on parse)
//   .bw-src/**                   — the author's original source tree (Code tab display + editing)
//   skills/** + README.md        — always ship by convention, plus the descriptor's `files` globs
//   .bw-machine/types/**         — the TypeScript types harvest (the machine layer the backend's
//                                  derivation sandbox resolves the run signature against, offline)
//
// A PYTHON package (resolved entry is `.py` — descriptor `entry`, or `main.py` at the root) packs
// the same shape minus the bundle: no `index.mjs` (Python has no bundle step — the shown source IS
// what runs), the `.py` source tree + `pyproject.toml`/`requirements.txt`/`uv.lock` under
// `.bw-src/`, and the machine layer is the uv-materialized dependency tree under
// `.bw-machine/site-packages/` (see MACHINE_SITE_PACKAGES_DIR for the binding layout contract).
//
// The artifact is content-addressed by the sha256 of its bytes: the same bytes the CLI uploads are
// the bytes the runner downloads + verifies, so integrity holds regardless of determinism;
// determinism just lets identical programs dedup.
//
// Pure logic + filesystem reads; no program execution, no network.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { create as tarCreate } from "tar";
import type { WorkflowDescriptor } from "@boardwalk-labs/workflow";
import { bundleWorkflowWithMap } from "./bundle.js";
import {
  loadDescriptor,
  resolveProjectRoot,
  resolveRunEntry,
  type LoadedDescriptor,
} from "./descriptor.js";
import { CliError } from "./errors.js";
import { isRecord } from "./guards.js";
import { harvestTypes, type TypesHarvest } from "./types_harvest.js";
import {
  detectPythonDeps,
  languageOfEntry,
  materializeSitePackages,
  type UvRunner,
  type WorkflowLanguage,
} from "./python.js";

const SDK_PACKAGE = "@boardwalk-labs/workflow";
/** The entry module the runner imports after extraction. The whole local graph bundles into it. */
export const ENTRY_OUTPUT = "index.mjs";
/** Where the author's ORIGINAL sources live inside the artifact, mirrored at their package-relative
 *  paths so a dashboard's code view shows what the user wrote (blank lines + comments intact) and
 *  quick-edit round-trips real source — NOT the blank-line-stripped esbuild bundle. For TypeScript
 *  the runner never reads `.bw-src/` (it runs {@link ENTRY_OUTPUT}); for Python the shown source
 *  IS what runs — the runner materializes the program from this tree (entry at its
 *  package-relative path) with `.bw-machine/site-packages/` on `sys.path`. */
export const SOURCE_DIR = ".bw-src";
/**
 * MACHINE-LAYER root (the two-layer artifact). Everything under this prefix is build-produced input
 * for the BACKEND DERIVATION SANDBOX, never author content: it is not rendered in the Code tab, not
 * editable, and not read by the runner.
 *
 * Layout contract (the backend's unpack/derivation side binds to exactly this):
 *
 *   .bw-machine/types/<project-relative path>
 *
 * i.e. the TypeScript types harvest mirrored at its on-disk relative paths under the project root:
 *   .bw-machine/types/node_modules/<pkg>/…/*.d.ts   (+ .d.mts / .d.cts)
 *   .bw-machine/types/node_modules/<pkg>/package.json
 *   .bw-machine/types/package.json                   (the project's own, for type/imports)
 *   .bw-machine/types/tsconfig.json                  (+ its in-project `extends` chain, which may
 *                                                     land under …/types/node_modules/…)
 * so the sandbox can chdir into `.bw-machine/types/`, drop the author sources beside it, and run
 * the compiler's normal resolution fully offline. Python's future machine layer (`site-packages`)
 * gets its own sibling under `.bw-machine/` — the `types/` segment is language-scoped on purpose.
 *
 * The harvest is ON BY DEFAULT for the new format (the backend reserves `.bw-machine/` alongside
 * `.bw-src/`); `--no-types-harvest` is the escape hatch for a build that doesn't want the bytes.
 */
export const MACHINE_DIR = ".bw-machine";
/** Where the TypeScript types harvest lives inside the artifact (see {@link MACHINE_DIR}). */
export const MACHINE_TYPES_DIR = `${MACHINE_DIR}/types`;
/**
 * Where a PYTHON package's materialized dependency layer lives — the ratified SIBLING of
 * `types/` under `.bw-machine/` (Implementation Plan P1.1/P5.4). Layout contract the backend's
 * derivation sandbox and the runner bind to:
 *
 *   .bw-machine/site-packages/<installed package tree>
 *
 * i.e. exactly what `uv pip install --target` produced for the frozen dependency set (module
 * trees, `*.dist-info/` metadata), targeting the hosted runner's platform (x86_64 Linux,
 * CPython 3.13) — so the runner can put this ONE directory on `sys.path` (and the derivation
 * sandbox can import against it) with no install and no network. Not byte-compiled for now
 * (`.pyc` is an open cold-start benchmark); `__pycache__` and console-script `bin/` shims are
 * never packed. A package with no declared dependencies has no layer at all — valid.
 */
export const MACHINE_SITE_PACKAGES_DIR = `${MACHINE_DIR}/site-packages`;
/** `sdk_version` for a program that pins no SDK version — defer to whatever the runner ships. */
export const UNPINNED_SDK = "*";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"] as const;

// Source the esbuild bundle already inlines (or emits) — stored under `.bw-src/`, never shipped
// raw as a runtime asset.
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".map"]);
// Build/config files that are not authored source.
const EXCLUDE_FILES = new Set<string>([
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  ".npmrc",
  ".npmignore",
  ".gitignore",
  ".eslintrc",
  ".eslintrc.json",
  ".prettierrc",
  ...LOCKFILES,
]);
const EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".boardwalk",
  "dist",
  "build",
  ".turbo",
  ".cache",
]);
/** The `files` conventions: `skills/**` and the root README always ship (§8 of the format spec). */
const SKILLS_DIR = "skills";
/** The workflow's landing-page filename, matched case-insensitively (README.md and readme.md are both
 *  common). ONE documented name, so a file either renders on the workflow's page or plainly doesn't,
 *  with no near-misses to guess at. Kept in lockstep with the dashboard's own lookup. */
const README_NAME = "readme.md";

/** One of the author's source files, stored under `.bw-src/` at its package-relative POSIX path. */
export interface ArtifactSource {
  relPath: string;
  content: Buffer;
}

/** One non-code file shipped in the artifact, at its package-relative POSIX path. */
export interface ArtifactAsset {
  /** Path inside the artifact (POSIX, package-relative), e.g. `skills/review.md`. */
  relPath: string;
  /** Absolute path on disk to read the bytes from. */
  absPath: string;
}

/** The built artifact + the metadata the deploy finalize call records on the version row. */
export interface BuiltArtifact {
  /** The `.tgz` bytes — the exact object uploaded to storage. */
  tarball: Uint8Array;
  /** sha256 hex of {@link tarball} — content-address + integrity digest. */
  digest: string;
  /** Byte length of {@link tarball}. */
  size: number;
  /** The program language, decided by the resolved entry (`.py` ⇒ python). */
  language: WorkflowLanguage;
  /** Entry module: {@link ENTRY_OUTPUT} for TypeScript (the bundle at the artifact root); for
   *  Python the PACKAGE-RELATIVE source path (e.g. `main.py`) — there is no bundle, and the
   *  file's bytes live under `.bw-src/` like the rest of the source tree. */
  entry: string;
  /** The workflow's slug, from the validated descriptor — the deploy identity. */
  slug: string;
  /** The descriptor's artifact-root filename (`workflow.jsonc` or `workflow.json`). */
  descriptorFileName: string;
  /** The parsed, fully-defaulted descriptor (for `check`/plan output — the artifact carries the raw text). */
  descriptor: WorkflowDescriptor;
  /** Resolved `@boardwalk-labs/workflow` version the program was built against, or {@link UNPINNED_SDK}. */
  sdkVersion: string;
  /** sha256 of the project's lockfile (reproducibility anchor), or null when there is none. */
  lockfileDigest: string | null;
  /** Sorted POSIX relative paths of the bundled assets (for `check` output + validation). */
  assetPaths: string[];
  /** Sorted artifact paths of the machine layer — under {@link MACHINE_TYPES_DIR} (TypeScript)
   *  or {@link MACHINE_SITE_PACKAGES_DIR} (Python). Empty when a TS build opted out via
   *  {@link BuildArtifactOptions.typesHarvest}, or a Python package declares no dependencies. */
  machinePaths: string[];
  /** Total pre-compression bytes of the machine-layer files (0 when not packed). */
  machineBytes: number;
}

/** Options for {@link buildArtifact}. */
export interface BuildArtifactOptions {
  /** Pack the TypeScript types harvest (the machine layer) under {@link MACHINE_TYPES_DIR}.
   *  Default ON — the backend derives the I/O schemas from it at deploy; `false` (surfaced as
   *  `--no-types-harvest`) skips the bytes. IGNORED for Python: its machine layer
   *  (site-packages) is load-bearing at runtime, not derivation-only, so there is no opt-out. */
  typesHarvest?: boolean;
  /** Test seam: how `uv` is invoked for a Python package's dependency layer. */
  uvRun?: UvRunner;
}

/** Build the deploy artifact for a workflow package (a directory with a `workflow.jsonc`). */
export async function buildArtifact(
  target: string,
  options: BuildArtifactOptions = {},
): Promise<BuiltArtifact> {
  const rootDir = resolveProjectRoot(target);
  const loaded = loadDescriptor(rootDir);
  const entry = resolveRunEntry(rootDir, loaded.descriptor);
  if (languageOfEntry(entry) === "python") {
    return buildPythonArtifact(rootDir, loaded, entry, options);
  }
  // Bundle FIRST — proves the program compiles and every non-SDK import resolves, with precise
  // esbuild errors, before any packaging work. Strip-only: the author's body is never type-checked.
  const { code, map } = await bundleWorkflowWithMap(entry);

  const assets = collectAssets(rootDir, loaded.descriptor.files, loaded.fileName);
  const sdkVersion = resolveSdkVersion(rootDir);
  const lockDigest = lockfileDigest(rootDir);
  // The package ships its WHOLE local source tree, rooted at the PACKAGE root (so `src/index.ts`
  // keeps its path): the tree is what a dashboard code view has to show, and it is the copy of the
  // program the platform can hand back. The runtime is unaffected: local modules are inlined into
  // ENTRY_OUTPUT.
  const sources = collectSources(rootDir);

  // The machine layer (default ON): the types harvest, mirrored under `.bw-machine/types/`.
  const harvest: TypesHarvest =
    options.typesHarvest === false ? { files: [], totalBytes: 0 } : harvestTypes(rootDir);

  const packed = await stageAndPack({
    // The bundle outputs live at the artifact root — the language-specific part of the layout.
    rootFiles: [
      { relPath: ENTRY_OUTPUT, bytes: Buffer.from(code, "utf8") },
      { relPath: `${ENTRY_OUTPUT}.map`, bytes: Buffer.from(map, "utf8") },
    ],
    loaded,
    sources,
    assets,
    machineDir: MACHINE_TYPES_DIR,
    machineFiles: harvest.files,
  });

  return {
    ...packed,
    language: "typescript",
    entry: ENTRY_OUTPUT,
    slug: loaded.descriptor.slug,
    descriptorFileName: loaded.fileName,
    descriptor: loaded.descriptor,
    sdkVersion,
    lockfileDigest: lockDigest,
    assetPaths: assets.map((a) => a.relPath).sort(),
    machineBytes: harvest.totalBytes,
  };
}

/**
 * The Python build path (P5.4): no esbuild bundle, no types harvest. The author layer is the
 * `.py` source tree (+ the dependency declarations, which round-trip because Python has no bundle
 * step) under `.bw-src/`; the machine layer is the uv-materialized site-packages under
 * {@link MACHINE_SITE_PACKAGES_DIR}. Dependencies resolve + freeze at BUILD time (`uv lock` may
 * refresh the project's `uv.lock` — the one project write); no dependencies ⇒ no layer, no uv.
 */
async function buildPythonArtifact(
  rootDir: string,
  loaded: LoadedDescriptor,
  entryAbs: string,
  options: BuildArtifactOptions,
): Promise<BuiltArtifact> {
  const deps = detectPythonDeps(rootDir);
  // Materialize FIRST: `uv lock` refreshes uv.lock, which then ships with the sources below.
  const site = deps === null ? null : materializeSitePackages(rootDir, deps, options.uvRun);
  try {
    const assets = collectAssets(rootDir, loaded.descriptor.files, loaded.fileName);
    const sources = collectPythonSources(rootDir);

    const packed = await stageAndPack({
      rootFiles: [], // no bundle step — the shown source IS what runs
      loaded,
      sources,
      assets,
      machineDir: MACHINE_SITE_PACKAGES_DIR,
      machineFiles: site?.files ?? [],
    });

    return {
      ...packed,
      language: "python",
      entry: toPosix(relative(rootDir, entryAbs)),
      slug: loaded.descriptor.slug,
      descriptorFileName: loaded.fileName,
      descriptor: loaded.descriptor,
      // The Python SDK ships in the runtime and isn't on PyPI yet — nothing to pin.
      sdkVersion: UNPINNED_SDK,
      lockfileDigest: pythonLockfileDigest(rootDir),
      assetPaths: assets.map((a) => a.relPath).sort(),
      machineBytes: site?.totalBytes ?? 0,
    };
  } finally {
    site?.cleanup();
  }
}

/** What both language paths hand {@link stageAndPack} — the shared artifact shape; only the
 *  root files (the TS bundle outputs) and the machine layer's directory + contents differ. */
interface ArtifactParts {
  /** Language-specific files at the artifact root (bytes already in memory). */
  rootFiles: readonly { relPath: string; bytes: Buffer }[];
  loaded: LoadedDescriptor;
  sources: readonly ArtifactSource[];
  assets: readonly ArtifactAsset[];
  /** {@link MACHINE_TYPES_DIR} or {@link MACHINE_SITE_PACKAGES_DIR}. */
  machineDir: string;
  /** Machine-layer files, staged by copy at `<machineDir>/<relPath>`. */
  machineFiles: readonly { relPath: string; absPath: string }[];
}

/**
 * The packaging shared by both build paths: stage every file at its artifact-relative path
 * (descriptor VERBATIM at the root — comments intact for the author, stripped only when the
 * control plane parses it — sources under `.bw-src/`, machine layer under `.bw-machine/…`),
 * then pack the staging dir deterministically and content-address the bytes.
 */
async function stageAndPack(
  parts: ArtifactParts,
): Promise<{ tarball: Uint8Array; digest: string; size: number; machinePaths: string[] }> {
  const { loaded, sources, assets } = parts;
  const machinePaths = parts.machineFiles.map((f) => `${parts.machineDir}/${f.relPath}`).sort();

  const staging = mkdtempSync(join(tmpdir(), "bw-artifact-"));
  try {
    for (const f of parts.rootFiles) writeStaged(staging, f.relPath, f.bytes);
    writeStaged(staging, loaded.fileName, Buffer.from(loaded.raw, "utf8"));
    for (const s of sources) writeStaged(staging, `${SOURCE_DIR}/${s.relPath}`, s.content);
    for (const asset of assets) writeStaged(staging, asset.relPath, readFileSync(asset.absPath));
    for (const f of parts.machineFiles) {
      copyStaged(staging, `${parts.machineDir}/${f.relPath}`, f.absPath);
    }

    const relPaths = [
      ...parts.rootFiles.map((f) => f.relPath),
      loaded.fileName,
      ...sources.map((s) => `${SOURCE_DIR}/${s.relPath}`),
      ...assets.map((a) => a.relPath),
      ...machinePaths,
    ].sort();
    const tarball = await packDir(staging, relPaths);
    return { tarball, digest: sha256Hex(tarball), size: tarball.length, machinePaths };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Collect the package's non-code assets: `skills/**` and the root README ship by CONVENTION (most
 * workflows declare nothing), plus whatever the descriptor's `files` allowlist globs match. An
 * allowlist, never an ignore-list — packaged files are stored on the control plane and shown to the
 * whole org, and a denylist leaks credentials the day someone drops a `.env` next to the entry.
 *
 * Regardless of any glob, `node_modules`, `.git`, `.env*`, and dotfiles are NEVER packaged (which
 * also protects the reserved `.bw-src/` / `.bw-machine/` namespaces). A `files` entry that matches
 * nothing is a precise authoring error. Returns a deterministic, path-sorted list with POSIX
 * relative paths.
 */
export function collectAssets(
  rootDir: string,
  filesGlobs: readonly string[] | undefined,
  descriptorFileName: string,
): ArtifactAsset[] {
  // Reserved staging paths a glob must never shadow: the bundle outputs and the descriptor slot
  // (the descriptor itself ships verbatim already; dotpaths are excluded by the walk filter).
  const reserved = new Set([ENTRY_OUTPUT, `${ENTRY_OUTPUT}.map`, descriptorFileName]);

  // One sweep of the packageable tree (never node_modules/.git/.env*/dotfiles).
  const candidates: ArtifactAsset[] = [];
  walk(rootDir, packageableFilter, (abs) => {
    const rel = toPosix(relative(rootDir, abs));
    if (rel.length === 0 || rel.startsWith("..") || reserved.has(rel)) return;
    candidates.push({ relPath: rel, absPath: abs });
  });

  const picked = new Map<string, ArtifactAsset>();
  const add = (a: ArtifactAsset): void => {
    if (!picked.has(a.relPath)) picked.set(a.relPath, a);
  };

  // Conventions: skills/** and the root README (case-insensitive, on-disk casing kept).
  for (const c of candidates) {
    if (c.relPath.startsWith(`${SKILLS_DIR}/`)) add(c);
    if (!c.relPath.includes("/") && c.relPath.toLowerCase() === README_NAME) add(c);
  }

  // The descriptor's allowlist: a glob (`prompts/**`), a file, or a directory (included recursively).
  for (const glob of filesGlobs ?? []) {
    const matches = candidates.filter((c) => matchesFilesEntry(glob, c.relPath));
    if (matches.length === 0) {
      throw new CliError(
        `The descriptor's files entry matched nothing: ${glob}`,
        "`files` is an allowlist of non-code assets to ship — check the path/glob (note: dotfiles, .env*, node_modules, and .git are never packaged).",
      );
    }
    for (const m of matches) add(m);
  }

  return [...picked.values()].sort(byRelPath);
}

/** The one path ordering every packed list uses (deterministic artifacts). */
function byRelPath(a: { relPath: string }, b: { relPath: string }): number {
  return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;
}

/** Hard exclusion rule for anything that ships: no dotfiles/dotdirs (covers `.env*`, `.git`,
 *  `.bw-*`, `.boardwalk`), no `node_modules`. */
function packageableFilter(isDir: boolean, name: string): boolean {
  if (name.startsWith(".")) return false;
  if (isDir) return name !== "node_modules";
  return true;
}

/** True when the descriptor `files` entry covers `relPath`: glob match, exact file, or dir prefix. */
function matchesFilesEntry(entry: string, relPath: string): boolean {
  const normalized = entry.replace(/^\.\//, "").replace(/\/+$/, "");
  if (normalized.length === 0) return false;
  if (normalized.includes("*") || normalized.includes("?")) {
    return globToRegExp(normalized).test(relPath);
  }
  return relPath === normalized || relPath.startsWith(`${normalized}/`);
}

/**
 * Minimal glob → RegExp for `files` entries: `**` crosses directories, `*`/`?` stay within one path
 * segment. Deliberately tiny (no braces/extglobs) — the npm-`files` subset authors actually write.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` (optionally followed by `/`) matches any depth, including none.
        i++;
        if (glob[i + 1] === "/") i++;
        out += "(?:.*)";
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += (ch ?? "").replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** Keep authored source files; skip build output, config, dotfiles, and excluded dirs. */
function sourceFilter(isDir: boolean, name: string): boolean {
  if (name.startsWith(".")) return false;
  if (isDir) return !EXCLUDE_DIRS.has(name);
  if (EXCLUDE_FILES.has(name)) return false;
  const ext = extOf(name);
  return SOURCE_EXT.has(ext) && ext !== ".map";
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** The author's source tree under the package root, for storage under `.bw-src/`. */
export function collectSources(root: string): ArtifactSource[] {
  return collectTree(root, sourceFilter);
}

/** Python source extensions (the author layer; `.pyc` never matches — compiled, not authored). */
const PY_SOURCE_EXT = new Set([".py", ".pyi"]);
/** Dependency declarations ship WITH the Python sources: there is no bundle step, so the artifact
 *  must carry everything needed to rebuild/re-resolve the program (web dependency edits, P5.6). */
const PY_INCLUDE_FILES = new Set(["pyproject.toml", "requirements.txt", "uv.lock"]);

/** The Python never-ship rules: dotfiles/dotdirs (covers `.venv`, `.env*`, `.git`), the shared
 *  excluded dirs, `__pycache__`, and `*.egg-info` build metadata. */
function pySourceFilter(isDir: boolean, name: string): boolean {
  if (name.startsWith(".")) return false;
  if (isDir) {
    return !EXCLUDE_DIRS.has(name) && name !== "__pycache__" && !name.endsWith(".egg-info");
  }
  if (PY_INCLUDE_FILES.has(name)) return true;
  return PY_SOURCE_EXT.has(extOf(name));
}

/** The author's Python source tree under the package root, for storage under `.bw-src/`. */
export function collectPythonSources(root: string): ArtifactSource[] {
  return collectTree(root, pySourceFilter);
}

/** Read the package-relative tree the `accept` filter keeps, sorted for determinism. */
function collectTree(
  root: string,
  accept: (isDir: boolean, name: string) => boolean,
): ArtifactSource[] {
  const out: ArtifactSource[] = [];
  walk(root, accept, (abs) => {
    const rel = toPosix(relative(root, abs));
    if (rel.length === 0 || rel.startsWith("..")) return;
    out.push({ relPath: rel, content: readFileSync(abs) });
  });
  return out.sort(byRelPath);
}

/** Recursively walk `dir`, calling `onFile(abs)` for each file the `accept` predicate keeps. */
function walk(
  dir: string,
  accept: (isDir: boolean, name: string) => boolean,
  onFile: (absPath: string) => void,
): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name);
    const isDir = ent.isDirectory();
    if (!accept(isDir, ent.name)) continue;
    if (isDir) walk(abs, accept, onFile);
    else if (ent.isFile()) onFile(abs);
  }
}

/**
 * Resolve the `@boardwalk-labs/workflow` version the program is built against (for runner SDK-layer
 * compat): prefer the actually-installed version, then the declared dependency range, else UNPINNED.
 */
export function resolveSdkVersion(pkgDir: string | null): string {
  if (pkgDir === null) return UNPINNED_SDK;

  const installed = readJsonRecord(join(pkgDir, "node_modules", SDK_PACKAGE, "package.json"));
  const version = nonEmptyString(installed?.version);
  if (version !== null) return version;

  const pkg = readJsonRecord(join(pkgDir, "package.json"));
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const deps = pkg?.[field];
    const range = isRecord(deps) ? nonEmptyString(deps[SDK_PACKAGE]) : null;
    if (range !== null) return range;
  }
  return UNPINNED_SDK;
}

/**
 * The machine-layer log line for build/check/deploy, or null when there is nothing to report
 * (a TypeScript build that opted out via `--no-types-harvest`). Python ALWAYS reports: its
 * machine layer (site-packages) is load-bearing at runtime, not derivation-only, so there is
 * no opt-out — this is the one place that rule lives for the command surfaces.
 */
export function machineSummaryLine(artifact: BuiltArtifact, typesHarvest: boolean): string | null {
  if (artifact.language !== "python" && !typesHarvest) return null;
  return formatMachineSummary(artifact);
}

/** One-line machine-layer summary for build logs (file count + MB, per the harvest spec). */
export function formatMachineSummary(artifact: BuiltArtifact): string {
  const n = artifact.machinePaths.length;
  const mb = (artifact.machineBytes / (1024 * 1024)).toFixed(1);
  if (artifact.language === "python") {
    if (n === 0) return "site-packages: none (no dependencies declared)";
    return `site-packages: ${String(n)} file${n === 1 ? "" : "s"}, ${mb} MB → ${MACHINE_SITE_PACKAGES_DIR}/`;
  }
  return `types harvest: ${String(n)} file${n === 1 ? "" : "s"}, ${mb} MB → ${MACHINE_TYPES_DIR}/`;
}

/** sha256 of the project's lockfile (first of pnpm/npm/yarn/bun found), or null when none. */
export function lockfileDigest(pkgDir: string): string | null {
  for (const name of LOCKFILES) {
    const p = join(pkgDir, name);
    if (existsSync(p)) return sha256Hex(readFileSync(p));
  }
  return null;
}

/** The Python reproducibility anchor: `uv.lock` (refreshed by the build) else `requirements.txt`
 *  (its own pin surface — pip convention has no project lockfile), else null. */
export function pythonLockfileDigest(pkgDir: string): string | null {
  for (const name of ["uv.lock", "requirements.txt"]) {
    const p = join(pkgDir, name);
    if (existsSync(p)) return sha256Hex(readFileSync(p));
  }
  return null;
}

// ----- internals -----

/** Deterministic tar.gz of `cwd`'s listed files: portable (no uid/gid/mtime), stable order. */
async function packDir(cwd: string, files: string[]): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  await new Promise<void>((res, rej) => {
    const stream = tarCreate({ cwd, gzip: true, portable: true, noMtime: true }, files);
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => {
      res();
    });
    stream.on("error", rej);
  });
  return new Uint8Array(Buffer.concat(chunks));
}

function writeStaged(root: string, relPath: string, bytes: Uint8Array): void {
  const abs = join(root, relPath.split(posix.sep).join(sep));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

/** Stage by copy (no in-memory buffering) — the machine layer can be thousands of files. */
function copyStaged(root: string, relPath: string, srcAbs: string): void {
  const abs = join(root, relPath.split(posix.sep).join(sep));
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(srcAbs, abs);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/** Parse a JSON file into a record; null on a missing/unreadable file or a non-object root. */
function readJsonRecord(jsonPath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
