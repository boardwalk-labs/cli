// SPDX-License-Identifier: MIT

// Build a deploy ARTIFACT — the frozen, content-addressed program the runner executes.
//
// The packaging model: a workflow is built into a JS artifact AT DEPLOY (never at runtime).
// `buildArtifact` esbuild-bundles the entry into one `index.mjs` (+ external sourcemap,
// `@boardwalk-labs/workflow` left external — the host layer), collects the package's non-code assets
// (markdown skills, prompt templates) at their relative paths, and packs the lot into a
// DETERMINISTIC `tar.gz`. The artifact is content-addressed by the sha256 of its bytes: the same
// bytes the CLI uploads are the bytes the runner downloads + verifies, so integrity holds
// regardless of determinism; determinism just lets identical programs dedup.
//
// Pure logic + filesystem reads; no program execution, no network.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { create as tarCreate } from "tar";
import { bundleWorkflowWithMap, isPackageDir, resolveEntry } from "./bundle.js";
import { CliError } from "./errors.js";
import { isRecord } from "./guards.js";

const SDK_PACKAGE = "@boardwalk-labs/workflow";
/** The entry module the runner imports after extraction. The whole local graph bundles into it. */
export const ENTRY_OUTPUT = "index.mjs";
/** Where the author's ORIGINAL sources live inside the artifact, stored verbatim so a dashboard's
 *  code view shows what the user wrote (blank lines + comments intact) and quick-edit round-trips
 *  real source — NOT the blank-line-stripped esbuild bundle. The runner never reads `.bw-src/`; it
 *  runs {@link ENTRY_OUTPUT}. */
export const SOURCE_DIR = ".bw-src";
/** A single-file program's source, stored under the canonical entry name. */
export const SOURCE_FILE = `${SOURCE_DIR}/index.ts`;
/** `sdk_version` for a program that pins no SDK version — defer to whatever the runner ships. */
export const UNPINNED_SDK = "*";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock"] as const;

// Source the esbuild bundle already inlines (or emits) — never shipped raw as a runtime asset.
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".map"]);
// Build/config files that are not runtime assets.
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
/** The workflow's landing-page filename, matched case-insensitively (README.md and readme.md are both
 *  common). ONE documented name, so a file either renders on the workflow's page or plainly doesn't,
 *  with no near-misses to guess at. Kept in lockstep with the dashboard's own lookup. */
const README_NAME = "readme.md";

/** One of the author's source files, stored under `.bw-src/` at its entry-relative POSIX path. */
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
  /** Entry module within the extracted tree ({@link ENTRY_OUTPUT}). */
  entry: string;
  /** Resolved `@boardwalk-labs/workflow` version the program was built against, or {@link UNPINNED_SDK}. */
  sdkVersion: string;
  /** sha256 of the project's lockfile (reproducibility anchor), or null when there is none. */
  lockfileDigest: string | null;
  /** The bundled entry source — lets the CLI extract `meta`/`name` without cracking the tarball. */
  entrySource: string;
  /** Sorted POSIX relative paths of the bundled assets (for `--check` output + validation). */
  assetPaths: string[];
}

/** Build the deploy artifact for a file or package directory. */
export async function buildArtifact(target: string): Promise<BuiltArtifact> {
  const entry = resolveEntry(target);
  const { code, map } = await bundleWorkflowWithMap(entry);
  // The author's original entry source — stored verbatim for display/quick-edit (the built `index.mjs`
  // has its blank lines + comments stripped by esbuild).
  const originalSource = readFileSync(entry, "utf8");

  const pkgDir = isPackageDir(target) ? resolve(target) : null;
  // A lone file ships no directory sweep — deploying `~/scratch/index.ts` must not publish all of
  // `~/scratch` — but its README still rides along, because the README always ships (readmeAsset).
  const assets = pkgDir === null ? readmeAsset(dirname(entry)) : collectAssets(pkgDir);
  const sdkVersion = resolveSdkVersion(pkgDir);
  const lockDigest = pkgDir === null ? null : lockfileDigest(pkgDir);
  // A package ships its WHOLE local source tree, not just the entry: the tree is what a dashboard
  // code view has to show (an entry importing `./plan.js` is unreadable — and un-editable — without
  // `plan.ts` beside it), and it is the copy of the program the platform can hand back. The runtime
  // is unaffected either way: local modules are inlined into ENTRY_OUTPUT. Rooted at the ENTRY's
  // directory so the stored paths keep the entry's own relative imports resolvable.
  const sources: ArtifactSource[] =
    pkgDir === null
      ? [{ relPath: "index.ts", content: Buffer.from(originalSource, "utf8") }]
      : collectSources(dirname(entry));

  // Stage every file at its target relative path, then pack the staging dir deterministically.
  const staging = mkdtempSync(join(tmpdir(), "bw-artifact-"));
  try {
    writeStaged(staging, ENTRY_OUTPUT, Buffer.from(code, "utf8"));
    writeStaged(staging, `${ENTRY_OUTPUT}.map`, Buffer.from(map, "utf8"));
    for (const s of sources) writeStaged(staging, `${SOURCE_DIR}/${s.relPath}`, s.content);
    for (const asset of assets) writeStaged(staging, asset.relPath, readFileSync(asset.absPath));

    const relPaths = [
      ENTRY_OUTPUT,
      `${ENTRY_OUTPUT}.map`,
      ...sources.map((s) => `${SOURCE_DIR}/${s.relPath}`),
      ...assets.map((a) => a.relPath),
    ].sort();
    const tarball = await packDir(staging, relPaths);

    return {
      tarball,
      digest: sha256Hex(tarball),
      size: tarball.length,
      entry: ENTRY_OUTPUT,
      sdkVersion,
      lockfileDigest: lockDigest,
      entrySource: code,
      assetPaths: assets.map((a) => a.relPath).sort(),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The README in `dir`, matched case-insensitively, as a 0-or-1 asset list.
 *
 * **The README always ships**, by every path into an artifact. It is documentation the CONTROL PLANE
 * renders — the workflow's landing page in the dashboard — not a runtime asset the program reads, so
 * neither rule that scopes RUNTIME assets has any business dropping it:
 *
 * - A lone-file deploy ships no directory sweep (`boardwalk deploy ~/scratch/index.ts` must not
 *   publish all of `~/scratch`), but one known filename is not a sweep.
 * - An explicit `boardwalk.assets` list scopes what the PROGRAM can read; it doesn't decide what
 *   documents the workflow. Without this, `assets: ["skills"]` silently blanked the landing page.
 *
 * This mirrors `npm pack`, which always includes README/LICENSE/package.json whatever `files` says —
 * the same npm-pack model {@link defaultAssetFilter} already follows. Nothing reads a README at run
 * time, so including it can never change how a program behaves.
 *
 * The inverse objection — "it's human docs, so shipping it adds bytes to every run for no runtime
 * benefit" — reads the artifact backwards, and is answered here so it isn't re-litigated. The
 * artifact is the VERSION RECORD, not a minimal runtime payload. Measured on the `hello` scaffold,
 * 84% of it is already not read at run time: `index.mjs.map` (1231 B) and `.bw-src/` (722 B) against
 * 567 B of executable `.mjs`, so the SOURCEMAP alone outweighs the README's 1004 B. The whole thing
 * gzips to ~1.5 KB, fetched once per run, by a run that then spends dollars on inference — and a
 * README is the smallest member of the not-read-at-run-time majority, not an anomaly in it. Dropping
 * it would need somewhere else to keep it, and being content-addressed WITH the version is precisely
 * what stops a workflow's docs drifting from the code they describe.
 *
 * Only the file directly in `dir`: a nested `skills/README.md` is that subtree's docs, not the
 * workflow's landing prose, and rides along as an ordinary asset (or not at all).
 */
function readmeAsset(dir: string): ArtifactAsset[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const name = names.find((n) => n.toLowerCase() === README_NAME);
  if (name === undefined) return [];
  const absPath = join(dir, name);
  // Keep the on-disk casing in the artifact; the dashboard matches case-insensitively.
  return statSync(absPath).isFile() ? [{ relPath: name, absPath }] : [];
}

/**
 * Collect the package's runtime assets. With an explicit `boardwalk.assets` list in package.json,
 * exactly those paths are shipped (a file, or a directory included recursively) — plus the README,
 * which always ships (see {@link readmeAsset}). Otherwise the default is npm-pack-style: every file
 * under the package root EXCEPT source the bundle already inlines, build/config files, dotfiles, and
 * excluded dirs (`node_modules`, `.git`, …). Returns a deterministic, path-sorted list with POSIX
 * relative paths.
 */
export function collectAssets(pkgDir: string): ArtifactAsset[] {
  const explicit = readAssetGlobs(pkgDir);
  const out: ArtifactAsset[] = [];
  const seen = new Set<string>();
  const add = (absPath: string): void => {
    const rel = toPosix(relative(pkgDir, absPath));
    if (rel.length === 0 || rel.startsWith("..") || seen.has(rel)) return;
    seen.add(rel);
    out.push({ relPath: rel, absPath });
  };

  if (explicit !== null) {
    for (const entry of explicit) {
      const abs = resolve(pkgDir, entry);
      if (!existsSync(abs)) {
        throw new CliError(`boardwalk.assets entry not found: ${entry}`);
      }
      if (statSync(abs).isDirectory()) walk(abs, () => true, add);
      else add(abs);
    }
    // The README rides along even when the explicit list omits it (`add` dedups if it named it).
    for (const readme of readmeAsset(pkgDir)) add(readme.absPath);
  } else {
    // The default rule already keeps it — a README is a non-source, non-config file.
    walk(pkgDir, defaultAssetFilter, add);
  }

  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/** Default include rule: keep non-source, non-config, non-dot files; prune excluded dirs. */
function defaultAssetFilter(isDir: boolean, name: string): boolean {
  if (name.startsWith(".")) return false; // dotfiles + dotdirs
  if (isDir) return !EXCLUDE_DIRS.has(name);
  if (EXCLUDE_FILES.has(name)) return false;
  return !SOURCE_EXT.has(extOf(name));
}

/** The mirror of {@link defaultAssetFilter}: the source files, which assets deliberately skip.
 *  Sourcemaps are build output, not authored source. */
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

/** The author's source tree under `root` (the entry's directory), for storage under `.bw-src/`. */
export function collectSources(root: string): ArtifactSource[] {
  const out: ArtifactSource[] = [];
  walk(root, sourceFilter, (abs) => {
    const rel = toPosix(relative(root, abs));
    if (rel.length === 0 || rel.startsWith("..")) return;
    out.push({ relPath: rel, content: readFileSync(abs) });
  });
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
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

/** Read `boardwalk.assets: string[]` from package.json, or null when unset/invalid. */
function readAssetGlobs(pkgDir: string): string[] | null {
  const pkgPath = join(pkgDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const boardwalk = isRecord(parsed) ? parsed.boardwalk : undefined;
    const assets = isRecord(boardwalk) ? boardwalk.assets : undefined;
    if (Array.isArray(assets) && assets.every((a): a is string => typeof a === "string")) {
      return assets;
    }
  } catch {
    // Unreadable package.json → fall back to the default asset rule.
  }
  return null;
}

/**
 * Resolve the `@boardwalk-labs/workflow` version the program is built against (for runner SDK-layer
 * compat): prefer the actually-installed version, then the declared dependency range, else UNPINNED.
 */
export function resolveSdkVersion(pkgDir: string | null): string {
  if (pkgDir === null) return UNPINNED_SDK;

  const installed = join(pkgDir, "node_modules", SDK_PACKAGE, "package.json");
  if (existsSync(installed)) {
    const v = readJsonField(installed, "version");
    if (v !== null) return v;
  }

  const pkgPath = join(pkgDir, "package.json");
  if (existsSync(pkgPath)) {
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const range = readDepRange(pkgPath, field, SDK_PACKAGE);
      if (range !== null) return range;
    }
  }
  return UNPINNED_SDK;
}

/** sha256 of the project's lockfile (first of pnpm/npm/yarn/bun found), or null when none. */
export function lockfileDigest(pkgDir: string): string | null {
  for (const name of LOCKFILES) {
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function readJsonField(jsonPath: string, field: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, "utf8"));
    if (isRecord(parsed)) {
      const v = parsed[field];
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch {
    // ignore
  }
  return null;
}

function readDepRange(pkgPath: string, field: string, dep: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = isRecord(parsed) ? parsed[field] : undefined;
    if (isRecord(deps)) {
      const range = deps[dep];
      if (typeof range === "string" && range.length > 0) return range;
    }
  } catch {
    // ignore
  }
  return null;
}
