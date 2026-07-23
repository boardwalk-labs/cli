// SPDX-License-Identifier: MIT

// `boardwalk check <dir>` — validate a workflow package locally (no auth, no network).
//
// A fast pre-flight, all local — everything a deploy does EXCEPT the upload:
//   1. locate `workflow.jsonc`/`workflow.json` at the package root and validate it against the
//      descriptor schema (the manifest minus the derived I/O schemas — the same schema the server
//      enforces), including the `concurrency.key` template syntax check;
//   2. esbuild-bundle the entry (proves it compiles, has no syntax errors, and that every non-SDK
//      import resolves — strip-only, the author's body is never type-checked);
//   3. pack the artifact, types harvest included (what the backend derives the I/O schemas from).
// A PYTHON package (entry `.py`) swaps step 2/3 for the Python path: no bundle, and the machine
// layer is the uv-materialized site-packages (resolution errors surface here exactly as at deploy).
// There is NO local schema derivation: the backend derives authoritatively at deploy and returns
// warnings — `check` says so instead of pretending.

import { buildArtifact, formatMachineSummary } from "../artifact.js";
import { resolveLog } from "../log.js";

export interface CheckOptions {
  file: string;
  /** Pack + report the TypeScript types harvest (machine layer). Default ON for the new format;
   *  `--no-types-harvest` opts out. */
  typesHarvest?: boolean | undefined;
}

export interface CheckDeps {
  log?: (line: string) => void;
}

export async function runCheck(opts: CheckOptions, deps: CheckDeps = {}): Promise<void> {
  const log = resolveLog(deps);

  const harvest = opts.typesHarvest !== false;
  // Build the artifact end-to-end (descriptor parse+validate, bundle, assets, harvest) — every
  // failure surfaces here as the same precise CliError a deploy would raise.
  const artifact = await buildArtifact(opts.file, { typesHarvest: harvest });
  const { descriptor } = artifact;
  const assets = artifact.assetPaths.length;

  log(`✓ "${artifact.slug}" is valid (${artifact.descriptorFileName})`);
  log(`  entry:    ${artifact.entry}${artifact.language === "python" ? " (python)" : ""}`);
  log(`  triggers: ${descriptor.triggers.map((t) => t.kind).join(", ")}`);
  const secrets = descriptor.permissions?.secrets;
  if (secrets !== undefined && secrets.length > 0) {
    log(`  secrets:  ${secrets.map((s) => s.name).join(", ")}`);
  }
  log(`  artifact: ${String(artifact.size)} bytes (sha256 ${artifact.digest.slice(0, 12)}…)`);
  if (assets > 0) log(`  assets:   ${artifact.assetPaths.join(", ")}`);
  // Python always reports its machine layer (site-packages is load-bearing, no opt-out).
  if (harvest || artifact.language === "python") log(`  ${formatMachineSummary(artifact)}`);
  log("  schemas:  derive at deploy (the backend reads the run() signature and returns warnings)");
  if (artifact.language === "python") {
    log(
      "  note:     hosted deploys don't accept Python entries yet (the backend's .py schema derivation is still landing) — the package builds and validates locally either way",
    );
  }
}
