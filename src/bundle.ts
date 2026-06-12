// Bundle-at-deploy.
//
// A workflow is a package with an `index` entrypoint; a single file is the no-deps case. When a
// program pulls in npm packages, we bundle it AT DEPLOY (not at runtime) via esbuild into one
// self-contained, version-pinned ESM artifact and upload THAT as the run's `source`:
//   - `@boardwalk/workflow` is marked EXTERNAL (host-provided — bundling a copy would give the
//     program its own host state, separate from the engine's, and break the host seam).
//   - `meta` stays a pure literal in the output, so engines re-derive the manifest from it.
//   - Bundling at deploy keeps run cold-start fast and pins deps at PR time.

import { build } from "esbuild";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { CliError } from "./errors.js";

const SDK_PACKAGE = "@boardwalk/workflow";
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
 * esbuild-bundle the entry into one self-contained ESM string. `@boardwalk/workflow` is left
 * external (host-provided). Not minified — the `meta` literal must stay statically extractable.
 */
export async function bundleWorkflow(entryFile: string): Promise<string> {
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
  /** The bundled ESM (`index.mjs`); `@boardwalk/workflow` left external, not minified. */
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
 * esbuild-bundle the entry for `boardwalk dev` — like {@link bundleWorkflow}, but
 * `@boardwalk/workflow` imports are rewritten to the ABSOLUTE path of the CLI's own installed
 * copy. The SDK's host state is a module-level singleton, so the program and the CLI must load
 * the SAME module instance for `installHost` (called by the CLI) to be visible to the program's
 * hooks; an absolute specifier guarantees that regardless of where the bundle file lives or
 * whether the project has its own `node_modules`.
 */
export async function bundleForDev(entryFile: string): Promise<string> {
  const requireFromCli = createRequire(import.meta.url);
  let result;
  try {
    result = await build({
      entryPoints: [entryFile],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      write: false,
      logLevel: "silent",
      legalComments: "none",
      plugins: [
        {
          name: "boardwalk-sdk-shared-instance",
          setup(b) {
            b.onResolve({ filter: /^@boardwalk\/workflow(\/.+)?$/ }, (args) => ({
              path: requireFromCli.resolve(args.path),
              external: true,
            }));
          },
        },
      ],
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

function readPkgEntry(pkgPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const pkg = parsed as Record<string, unknown>;
      if (typeof pkg.module === "string") return pkg.module;
      if (typeof pkg.main === "string") return pkg.main;
    }
  } catch {
    // Unreadable package.json → fall back to index.* discovery.
  }
  return null;
}
