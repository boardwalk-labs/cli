// SPDX-License-Identifier: MIT

// Manifest extraction for CLI commands — thin wrappers over `@boardwalk-labs/workflow/extract`,
// translating extraction/validation failures into actionable `CliError`s.
//
// Two tiers, on purpose:
//   - `extractWorkflowSlug` — slug only. `deploy`/`run` need the deploy identity (create-vs-update
//     is matched by SLUG, which is environment-independent, unlike a path or stored id); the server
//     re-derives and validates the FULL manifest from the uploaded source, so the CLI doesn't
//     pre-judge field-level validity on the way to a deploy.
//   - `extractValidatedManifest` — the full schema. `check` and `dev` run entirely locally, so they
//     ARE the validator: same extractor, same schema, same errors as every engine.
//
// Pure logic; the program is never executed.

import {
  extractManifest,
  extractMetaLiteral,
  MetaExtractionError,
} from "@boardwalk-labs/workflow/extract";
import { MetaValidationError, type WorkflowManifest } from "@boardwalk-labs/workflow";
import { CliError } from "./errors.js";

/**
 * Statically read `export const meta = { slug: "...", ... }` and return the slug string.
 * Throws `CliError` when there is no pure-literal `meta` or `slug` is missing/empty/not a string.
 */
export function extractWorkflowSlug(source: string, fileName = "index.ts"): string {
  const meta = extractLiteralOrThrow(source, fileName);
  const slug = meta.slug;
  if (slug !== undefined && typeof slug !== "string") {
    throw new CliError("`meta.slug` must be a plain string literal.");
  }
  const trimmed = typeof slug === "string" ? slug.trim() : "";
  if (trimmed.length === 0) {
    throw new CliError(
      "`meta.slug` is missing or empty.",
      "Give the workflow a stable slug — it's the deploy identity used to match create vs update.",
    );
  }
  return trimmed;
}

/**
 * Statically extract `meta` and validate it against the manifest schema (the same one every
 * engine consumes), returning the fully-defaulted manifest. Throws `CliError` with the precise
 * extraction or per-field validation failure.
 */
export function extractValidatedManifest(source: string, fileName = "index.ts"): WorkflowManifest {
  try {
    return extractManifest(source, { fileName });
  } catch (err) {
    if (err instanceof MetaExtractionError) {
      throw new CliError(err.message, META_HINT);
    }
    if (err instanceof MetaValidationError) {
      throw new CliError(err.message);
    }
    throw err;
  }
}

const META_HINT =
  "A workflow program must export a pure-literal `export const meta = { … }` " +
  "(no spreads, calls, or interpolation — engines read it without executing your code).";

function extractLiteralOrThrow(source: string, fileName: string): Record<string, unknown> {
  try {
    return extractMetaLiteral(source, { fileName });
  } catch (err) {
    if (err instanceof MetaExtractionError) {
      throw new CliError(err.message, META_HINT);
    }
    throw err;
  }
}
