// SPDX-License-Identifier: MIT

// Bundle-at-deploy.
//
// A workflow package's entry (`src/index.ts`, exporting the default `run` function) is bundled AT
// DEPLOY (not at runtime) via esbuild into one self-contained, version-pinned ESM artifact:
//   - `@boardwalk-labs/workflow` is marked EXTERNAL (host-provided — bundling a copy would give the
//     program its own host state, separate from the engine's, and break the host seam).
//   - Strip-only: the author's body is never type-checked here (types feed the backend's schema
//     derivation via the types harvest, not the bundle).
//   - Bundling at deploy keeps run cold-start fast and pins deps at PR time.

import { build } from "esbuild";
import { CliError } from "./errors.js";

const SDK_PACKAGE = "@boardwalk-labs/workflow";

/** A bundled program plus its external sourcemap (for run-error symbolication back to user files). */
export interface BundledProgram {
  /** The bundled ESM (`index.mjs`); `@boardwalk-labs/workflow` left external, not minified. */
  code: string;
  /** The external sourcemap JSON (`index.mjs.map`). */
  map: string;
}

/**
 * esbuild-bundle the entry into `{ code, map }` for the deploy ARTIFACT, emitting a `linked`
 * sourcemap so a run's stack traces resolve back to the author's files. Output names are fixed
 * (`index.mjs` / `index.mjs.map`) so the linked `sourceMappingURL` matches the artifact's layout.
 * Uses Bun's native bundler when the CLI runs as a Bun single-file executable (esbuild ships a
 * native binary that can't be embedded in the compiled binary); the esbuild path is the norm.
 */
export async function bundleWorkflowWithMap(entryFile: string): Promise<BundledProgram> {
  if (typeof Bun !== "undefined") {
    const { code, map } = await bunBundle(Bun, entryFile);
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
 * as the esbuild function above: ESM, SDK external, not minified (readable stored program). We
 * request an EXTERNAL sourcemap (no auto comment) and append the fixed `index.mjs.map` link
 * ourselves, so the artifact layout matches the esbuild path exactly.
 */
async function bunBundle(
  bun: NonNullable<typeof Bun>,
  entryFile: string,
): Promise<{ code: string; map?: string }> {
  let result: BunBuildOutput;
  try {
    result = await bun.build({
      entrypoints: [entryFile],
      target: "node",
      format: "esm",
      external: [SDK_PACKAGE, `${SDK_PACKAGE}/*`],
      sourcemap: "external",
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
  const mapArtifact = result.outputs.find((o) => o.kind === "sourcemap");
  if (mapArtifact === undefined) return { code };
  const map = await mapArtifact.text();
  return { code: `${code}\n//# sourceMappingURL=index.mjs.map\n`, map };
}
