// SPDX-License-Identifier: MIT

// `boardwalk check <file|dir>` — validate a workflow locally (no auth, no network).
//
// A fast pre-flight, all local:
//   1. extract the pure-literal `meta` and validate it against the FULL manifest schema — the
//      same schema every engine enforces, so a green `check` means the manifest is the contract;
//   2. esbuild-bundle the program (proves it compiles, has no syntax errors, and that every
//      non-SDK import resolves).
// Anything wrong throws a precise CliError before any deploy or run.

import { readFileSync } from "node:fs";
import { buildArtifact } from "../artifact.js";
import { resolveEntry } from "../bundle.js";
import { extractValidatedManifest } from "../manifest.js";
import { enforceDeterminism } from "../lint.js";
import { resolveLog } from "../log.js";

export interface CheckOptions {
  file: string;
  /** Pass `check` even when the determinism lint flags bare nondeterministic calls (the escape hatch). */
  allowNondeterminism?: boolean | undefined;
}

export interface CheckDeps {
  log?: (line: string) => void;
}

export async function runCheck(opts: CheckOptions, deps: CheckDeps = {}): Promise<void> {
  const log = resolveLog(deps);

  // Validate the manifest from the author's ORIGINAL entry source (errors point at real lines).
  const entry = resolveEntry(opts.file);
  const source = readFileSync(entry, "utf8");
  const manifest = extractValidatedManifest(source, entry);

  // Build the artifact (esbuild bundle + assets) — proves the program compiles end-to-end.
  const artifact = await buildArtifact(opts.file);
  const assets = artifact.assetPaths.length;

  // Determinism gate — bare nondeterminism outside a journaled seam corrupts a run on resume/crash,
  // so it fails `check` (the escape hatch is --allow-nondeterminism). Runs before the "valid" banner
  // so a failure stops here.
  enforceDeterminism(source, entry, log, opts.allowNondeterminism ?? false);

  log(`✓ "${manifest.slug}" is valid`);
  log(`  entry:    ${artifact.entry}`);
  log(`  triggers: ${manifest.triggers.map((t) => t.kind).join(", ")}`);
  const secrets = manifest.permissions?.secrets;
  if (secrets !== undefined && secrets.length > 0) {
    log(`  secrets:  ${secrets.map((s) => s.name).join(", ")}`);
  }
  log(`  artifact: ${String(artifact.size)} bytes (sha256 ${artifact.digest.slice(0, 12)}…)`);
  if (assets > 0) log(`  assets:   ${artifact.assetPaths.join(", ")}`);
}
