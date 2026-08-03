// SPDX-License-Identifier: MIT

// `boardwalk check <dir>` — validate a workflow package locally (no auth, no network).
//
// A fast pre-flight, all local — everything a deploy does EXCEPT the upload:
//   1. locate `workflow.jsonc`/`workflow.json` at the package root and validate it against the
//      descriptor schema (the manifest minus the derived I/O schemas — the same schema the server
//      enforces), including the `concurrency.key` template syntax check;
//   2. esbuild-bundle the entry (proves it compiles, has no syntax errors, and that every non-SDK
//      import resolves — strip-only, the bundle itself is never type-checked);
//   3. typecheck with the package's OWN tsc when it has one (tsconfig.json + a resolvable
//      `typescript`) — fail-soft to a note otherwise, `--no-typecheck` opts out;
//   4. pack the artifact, types harvest included (what the backend derives the I/O schemas from).
// A PYTHON package (entry `.py`) swaps step 2/3 for the Python path: no bundle, and the machine
// layer is the uv-materialized site-packages (resolution errors surface here exactly as at deploy).
// There is NO local schema derivation: the backend derives authoritatively at deploy and returns
// warnings — `check` says so instead of pretending.

import { buildArtifact, machineSummaryLine } from "../artifact.js";
import { resolveProjectRoot } from "../descriptor.js";
import { resolveLog } from "../log.js";
import { detectPythonDeps } from "../python.js";
import { typecheckPackage, type TscRunner } from "../typecheck.js";

export interface CheckOptions {
  file: string;
  /** Pack + report the TypeScript types harvest (machine layer). Default ON for the new format;
   *  `--no-types-harvest` opts out. */
  typesHarvest?: boolean | undefined;
  /** Run the package's own tsc (default ON for TypeScript packages); `--no-typecheck` opts out. */
  typecheck?: boolean | undefined;
}

export interface CheckDeps {
  log?: (line: string) => void;
  /** Test seam for the tsc invocation. */
  tscRunner?: TscRunner;
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
  const machineSummary = machineSummaryLine(artifact, harvest);
  if (machineSummary !== null) log(`  ${machineSummary}`);
  if (artifact.language !== "python" && opts.typecheck !== false) {
    const outcome = typecheckPackage(resolveProjectRoot(opts.file), deps.tscRunner);
    log(`  types:    ${outcome.ran ? "OK (tsc --noEmit)" : (outcome.note ?? "not checked")}`);
  }
  log("  schemas:  derive at deploy (the backend reads the run() signature and returns warnings)");
  if (artifact.language === "python" && !hasPydanticDep(opts.file)) {
    log(
      "  note:     typed input/output forms need `pydantic` in the package's dependencies — without it the schemas honestly degrade to raw JSON",
    );
  }
}

/** Whether the package declares pydantic (the note above is noise when it already does). */
function hasPydanticDep(target: string): boolean {
  const deps = detectPythonDeps(resolveProjectRoot(target));
  return deps?.specs.some((spec) => /^pydantic\b/i.test(spec.trim())) ?? false;
}
