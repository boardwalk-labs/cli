// SPDX-License-Identifier: MIT

// `boardwalk build <dir> [--out <path>]` — build a workflow package into its deploy artifact.
//
// Produces the EXACT content-addressed `.tgz` a deploy uploads: the bundled entry (`index.mjs` +
// sourcemap, `@boardwalk-labs/workflow` left external), the descriptor verbatim at the artifact
// root, the author's source tree under `.bw-src/`, `skills/**` + README + the descriptor's `files`
// assets, and the TypeScript types harvest under `.bw-machine/types/` (on by default — the backend
// derives the I/O schemas from it at deploy). Default output: `<slug>.tgz` in the cwd.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildArtifact, machineSummaryLine } from "../artifact.js";
import { resolveLog } from "../log.js";

export interface BuildOptions {
  file: string;
  out?: string | undefined;
  /** Pack the types harvest (default ON; `--no-types-harvest` opts out). */
  typesHarvest?: boolean | undefined;
}

export interface BuildDeps {
  /** Status line writer (defaults to stdout) — injected so tests don't touch the console. */
  log?: (line: string) => void;
}

/** Build the workflow artifact and return the absolute path it was written to. */
export async function runBuild(opts: BuildOptions, deps: BuildDeps = {}): Promise<string> {
  const log = resolveLog(deps);

  const harvest = opts.typesHarvest !== false;
  const artifact = await buildArtifact(opts.file, { typesHarvest: harvest });

  const outPath = resolve(opts.out ?? `${artifact.slug}.tgz`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, artifact.tarball);

  log(
    `built "${artifact.slug}" → ${outPath} (${String(artifact.size)} bytes, sha256 ${artifact.digest.slice(0, 12)}…)`,
  );
  const machineSummary = machineSummaryLine(artifact, harvest);
  if (machineSummary !== null) log(`  ${machineSummary}`);
  return outPath;
}
