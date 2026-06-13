// `boardwalk build <file|dir> [--out <path>]` — bundle a workflow to a single deployable file.
//
// Emits one ESM file with `@boardwalk-labs/workflow` left EXTERNAL (the engine resolves its own
// copy at run time) and the pure-literal `meta` intact — exactly what a self-hosted server's
// workflows directory loads (BOARDWALK_WORKFLOWS_DIR). The manifest is validated first so authoring
// mistakes surface here, not at deploy. Default output: `<workflow-name>.mjs` in the cwd.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { bundleWorkflow, resolveEntry } from "../bundle.js";
import { extractValidatedManifest } from "../manifest.js";

export interface BuildOptions {
  file: string;
  out?: string | undefined;
}

export interface BuildDeps {
  /** Status line writer (defaults to stdout) — injected so tests don't touch the console. */
  log?: (line: string) => void;
}

/** Build the workflow and return the absolute path it was written to. */
export async function runBuild(opts: BuildOptions, deps: BuildDeps = {}): Promise<string> {
  const log =
    deps.log ??
    ((line: string): void => {
      process.stdout.write(`${line}\n`);
    });

  const entry = resolveEntry(opts.file);
  // Validate before bundling: precise manifest errors here, and the name seeds the default output.
  const manifest = extractValidatedManifest(readFileSync(entry, "utf8"), entry);
  const program = await bundleWorkflow(entry);

  const outPath = resolve(opts.out ?? `${manifest.name}.mjs`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, program, "utf8");

  log(`built "${manifest.name}" → ${outPath}`);
  return outPath;
}
