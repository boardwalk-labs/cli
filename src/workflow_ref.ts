// SPDX-License-Identifier: MIT

// Resolve a workflow reference the user typed — either a workflow id (a ULID, as in a dashboard URL)
// or a human slug — to the id the id-keyed endpoints want. Shared by `runs --workflow` and the
// `workflows` subcommands so they accept the same `<id|slug>` everywhere.

import { CliError } from "./errors.js";
import type { BoardwalkClient } from "./client.js";

/** A Crockford-base32 ULID (26 chars, no I/L/O/U). Workflow ids look like `01KV4SMQ0JFCNH9X4VQVW10STZ`. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** True when `ref` is shaped like a workflow id (a ULID) rather than a slug. */
export function looksLikeWorkflowId(ref: string): boolean {
  return ULID_RE.test(ref.trim());
}

/**
 * Resolve a workflow `id|slug` to its id. A ULID passes straight through (no lookup); a slug is
 * resolved against the org's workflow list, so the slug form needs an org (`--org` or a project
 * link). Throws an actionable `CliError` when the slug isn't found or no org is available.
 */
export async function resolveWorkflowId(
  client: BoardwalkClient,
  org: string | undefined,
  ref: string,
): Promise<string> {
  const trimmed = ref.trim();
  if (looksLikeWorkflowId(trimmed)) return trimmed;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      `Need an org to resolve the workflow slug "${trimmed}".`,
      "Pass --org <slug>, run from a linked project, or pass the workflow id directly.",
    );
  }
  const list = await client.listWorkflowSummaries(org);
  const hit = list.find((w) => w.slug === trimmed);
  if (hit === undefined) {
    throw new CliError(
      `No workflow "${trimmed}" found in ${org}.`,
      "Check the slug with `boardwalk workflows`, or pass the workflow id.",
    );
  }
  return hit.id;
}
