// SPDX-License-Identifier: MIT

// Bundle-at-deploy.
//
// A workflow is a package with an `index` entrypoint; a single file is the no-deps case. When a
// program pulls in npm packages, we bundle it AT DEPLOY (not at runtime) via esbuild into one
// self-contained, version-pinned ESM artifact and upload THAT as the run's `source`:
//   - `@boardwalk-labs/workflow` is marked EXTERNAL (host-provided — bundling a copy would give the
//     program its own host state, separate from the engine's, and break the host seam).
//   - `meta` stays a pure literal in the output, so engines re-derive the manifest from it.
//   - Bundling at deploy keeps run cold-start fast and pins deps at PR time.

import { build } from "esbuild";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";
import { isRecord } from "./guards.js";

const SDK_PACKAGE = "@boardwalk-labs/workflow";
const ENTRY_CANDIDATES = ["index.ts", "index.mts", "index.js", "index.mjs"];

/** True when `target` is a directory (a workflow package), vs. a single program file. */
export function isPackageDir(target: string): boolean {
  try {
    return statSync(resolve(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve a deploy/dev target to its entry file: a file path returns itself; a directory resolves
 * via package.json `module`/`main`, then `index.{ts,mts,js,mjs}`.
 */
export function resolveEntry(target: string): string {
  const abs = resolve(target);
  let isDir: boolean;
  try {
    isDir = statSync(abs).isDirectory();
  } catch {
    throw new CliError(`Path not found: ${target}`);
  }
  if (!isDir) return abs;

  const pkgPath = join(abs, "package.json");
  if (existsSync(pkgPath)) {
    const entry = readPkgEntry(pkgPath);
    if (entry !== null) {
      const entryAbs = resolve(abs, entry);
      if (existsSync(entryAbs)) return entryAbs;
    }
  }
  for (const name of ENTRY_CANDIDATES) {
    const candidate = join(abs, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new CliError(
    `No entry file found in ${target}`,
    `Add an ${ENTRY_CANDIDATES.join(" / ")}, or set "module"/"main" in package.json.`,
  );
}

/**
 * Bundle the entry into one self-contained ESM string. `@boardwalk-labs/workflow` is left external
 * (host-provided). Not minified — the `meta` literal must stay statically extractable. Uses Bun's
 * native bundler when the CLI runs as a Bun single-file executable (esbuild ships a native binary
 * that can't be embedded in the compiled binary); the esbuild path is unchanged under Node.
 */
export async function bundleWorkflow(entryFile: string): Promise<string> {
  if (typeof Bun !== "undefined") return (await bunBundle(Bun, entryFile, false)).code;
  let result;
  try {
    result = await build({
      entryPoints: [entryFile],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: [SDK_PACKAGE, `${SDK_PACKAGE}/*`],
      write: false,
      logLevel: "silent",
      legalComments: "none",
    });
  } catch (err) {
    throw new CliError(
      `Bundling failed for ${entryFile}.`,
      err instanceof Error ? err.message : undefined,
    );
  }
  const out = result.outputFiles[0];
  if (out === undefined) throw new CliError(`Bundling produced no output for ${entryFile}.`);
  return out.text;
}

/** A bundled program plus its external sourcemap (for run-error symbolication back to user files). */
export interface BundledProgram {
  /** The bundled ESM (`index.mjs`); `@boardwalk-labs/workflow` left external, not minified. */
  code: string;
  /** The external sourcemap JSON (`index.mjs.map`). */
  map: string;
}

/**
 * esbuild-bundle the entry into `{ code, map }` for the deploy ARTIFACT. Same externals/format as
 * {@link bundleWorkflow} but emits a `linked` sourcemap so a run's stack traces resolve back to the
 * author's files. Output names are fixed (`index.mjs` / `index.mjs.map`) so the linked
 * `sourceMappingURL` matches the artifact's layout.
 */
export async function bundleWorkflowWithMap(entryFile: string): Promise<BundledProgram> {
  if (typeof Bun !== "undefined") {
    const { code, map } = await bunBundle(Bun, entryFile, true);
    if (map === undefined) throw new CliError(`Bundling produced no sourcemap for ${entryFile}.`);
    return { code, map };
  }
  let result;
  try {
    result = await build({
      entryPoints: [entryFile],
      outfile: "index.mjs",
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: [SDK_PACKAGE, `${SDK_PACKAGE}/*`],
      sourcemap: "linked",
      minify: false,
      write: false,
      logLevel: "silent",
      legalComments: "none",
    });
  } catch (err) {
    throw new CliError(
      `Bundling failed for ${entryFile}.`,
      err instanceof Error ? err.message : undefined,
    );
  }
  const js = result.outputFiles.find((f) => !f.path.endsWith(".map"));
  const map = result.outputFiles.find((f) => f.path.endsWith(".map"));
  if (js === undefined || map === undefined) {
    throw new CliError(`Bundling produced no output for ${entryFile}.`);
  }
  return { code: js.text, map: map.text };
}

/**
 * The Bun-native bundler path (used only inside the compiled single-file executable). Same contract
 * as the esbuild functions above: ESM, SDK external, NOT minified so `meta` stays extractable. For
 * the map case we request an EXTERNAL sourcemap (no auto comment) and append the fixed
 * `index.mjs.map` link ourselves, so the artifact layout matches the esbuild path exactly.
 */
async function bunBundle(
  bun: NonNullable<typeof Bun>,
  entryFile: string,
  withMap: boolean,
): Promise<{ code: string; map?: string }> {
  let result: BunBuildOutput;
  try {
    result = await bun.build({
      entrypoints: [entryFile],
      target: "node",
      format: "esm",
      external: [SDK_PACKAGE, `${SDK_PACKAGE}/*`],
      sourcemap: withMap ? "external" : "none",
      minify: false,
    });
  } catch (err) {
    throw new CliError(
      `Bundling failed for ${entryFile}.`,
      err instanceof Error ? err.message : undefined,
    );
  }
  if (!result.success) {
    const detail = result.logs.map((l) => String(l)).join("\n");
    throw new CliError(`Bundling failed for ${entryFile}.`, detail.length > 0 ? detail : undefined);
  }
  const js = result.outputs.find((o) => o.kind === "entry-point");
  if (js === undefined) throw new CliError(`Bundling produced no output for ${entryFile}.`);
  const code = await js.text();
  if (!withMap) return { code };
  const mapArtifact = result.outputs.find((o) => o.kind === "sourcemap");
  if (mapArtifact === undefined) return { code };
  const map = await mapArtifact.text();
  return { code: `${code}\n//# sourceMappingURL=index.mjs.map\n`, map };
}

function readPkgEntry(pkgPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (isRecord(parsed)) {
      if (typeof parsed.module === "string") return parsed.module;
      if (typeof parsed.main === "string") return parsed.main;
    }
  } catch {
    // Unreadable package.json → fall back to index.* discovery.
  }
  return null;
}
