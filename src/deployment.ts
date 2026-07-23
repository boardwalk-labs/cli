// SPDX-License-Identifier: MIT

// Shared deploy logic for `boardwalk deploy` and `boardwalk run`.
//
// Deploy is artifact-based: build the workflow package into a content-addressed tarball (descriptor
// validated, entry bundled, types harvest packed), upload it straight to object storage via a
// presigned PUT (the CLI holds no storage credentials), then finalize the version with a reference
// the server re-reads + verifies. The server derives the I/O schemas from the harvest and may
// return derivation WARNINGS, surfaced to the author.
//
// Identity is `(org from the deploy context, slug from the descriptor)` — the descriptor commits no
// org, so a template deploys to whoever runs it. Org resolution is DETERMINISTIC, never guessed
// (gap-closure Decision 11):
//   1. `--org <slug>` wins (it must be within the credential's reach when that's known);
//   2. else a single-org credential's scope is unambiguous;
//   3. else the CLI's active-org context (the project link written by a previous deploy);
//   4. else — a multi-org credential with no selection — a HARD ERROR listing the orgs.
// A deploy that would CREATE a new workflow confirms interactively (skippable with `--yes` for CI).

import { CliError } from "./errors.js";
import { buildArtifact, type BuildArtifactOptions, type BuiltArtifact } from "./artifact.js";
import { projectDirFor, readLink, writeLink } from "./project.js";
import type {
  BoardwalkClient,
  DeployArtifactRef,
  DeployResult,
  WorkflowSummary,
} from "./client.js";

export interface PreparedProgram {
  slug: string;
  /** Entry module inside the artifact (e.g. `index.mjs`). */
  entry: string;
  /** The built, content-addressed program artifact (tarball + digest + metadata). */
  artifact: BuiltArtifact;
}

/**
 * Resolve a target path to its deployable artifact: build the package (descriptor + bundle +
 * assets + types harvest → tarball, content-addressed). The slug — the deploy identity — comes
 * from the validated descriptor.
 */
export async function loadProgram(
  file: string,
  build: BuildArtifactOptions = {},
): Promise<PreparedProgram> {
  const artifact = await buildArtifact(file, build);
  return { slug: artifact.slug, entry: artifact.entry, artifact };
}

export interface DeployPlan {
  action: "create" | "update";
  slug: string;
  /** Present only for `update` — the existing workflow id to PUT. */
  workflowId?: string;
}

/** Decide create vs update by matching the program slug against the org's existing workflows. */
export function planDeploy(existing: readonly WorkflowSummary[], slug: string): DeployPlan {
  const match = existing.find((w) => w.slug === slug);
  return match !== undefined
    ? { action: "update", slug, workflowId: match.id }
    : { action: "create", slug };
}

// ── Org resolution (Decision 11) ────────────────────────────────────────────────────────

export interface OrgResolutionInput {
  /** `--org <slug>`, when given. */
  orgFlag?: string | undefined;
  /** Org slugs the credential can act in, or null when unknown (older backend / lookup failed). */
  credentialOrgs: readonly string[] | null;
  /** The project link's org — the CLI's active-org context for this directory — or null. */
  linkOrg: string | null;
}

/**
 * Deterministic org resolution — `--org` > a single-org credential's scope > the active-org
 * context > a hard error. Never guesses: a multi-org credential with no selection is an error
 * listing the orgs, and a given `--org` outside the credential's known scope is an error too
 * (for a single-org credential that IS the mismatch rule).
 */
export function resolveDeployOrg(input: OrgResolutionInput): string {
  const scope = input.credentialOrgs;

  if (input.orgFlag !== undefined && input.orgFlag.length > 0) {
    if (scope !== null && !scope.includes(input.orgFlag)) {
      throw new CliError(
        `--org "${input.orgFlag}" doesn't match your credential's org${scope.length === 1 ? ` ("${scope[0] ?? ""}")` : `s`}.`,
        scope.length > 0
          ? `This credential can deploy to: ${scope.join(", ")}.`
          : "This credential belongs to no orgs.",
      );
    }
    return input.orgFlag;
  }

  if (scope !== null && scope.length === 1 && scope[0] !== undefined) return scope[0];

  // Active-org context: only trusted when it's within the credential's known scope.
  if (input.linkOrg !== null && (scope === null || scope.includes(input.linkOrg))) {
    return input.linkOrg;
  }

  throw new CliError(
    "No org selected.",
    scope !== null && scope.length > 1
      ? `Your credential can deploy to: ${scope.join(", ")}. Pass --org <slug>.`
      : "Pass --org <slug>.",
  );
}

/** The org slugs the credential can act in, via GET /v1/me — or null when that can't be read
 *  (an older backend, an org-scoped API key without /v1/me, a transient failure). Null means
 *  "scope unknown": resolution then relies on --org / the project link, never a guess. */
export async function fetchCredentialOrgs(client: BoardwalkClient): Promise<string[] | null> {
  try {
    const me = await client.getMe();
    const slugs = me.memberships
      .map((m) => m.slug)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
    return [...new Set(slugs)];
  } catch {
    return null;
  }
}

// ── Deploy ──────────────────────────────────────────────────────────────────────────────

export interface DeployResultSummary {
  workflowId: string;
  orgSlug: string;
  versionNumber: number;
  /** "created" a new workflow, "updated" the linked one, or "adopted" an existing same-name one. */
  outcome: "created" | "updated" | "adopted";
  /** True when this deploy wrote a `.gitignore` entry for `.boardwalk/`. */
  gitignoreUpdated: boolean;
  /** The slug of the workflow this actually deployed to (server-side; immutable after create). On the
   *  LINKED path this is the linked workflow's slug, which may differ from the descriptor's `slug` —
   *  the directory link is keyed by workflow id, not slug (so a rename keeps the same workflow). The
   *  caller logs THIS (not the descriptor's slug) so a run is never silently attributed to the wrong
   *  name. */
  deployedSlug: string;
  /** The descriptor's `slug`, when it differs from {@link deployedSlug} (else undefined). A mismatch
   *  means the linked directory points at a different-named workflow — the caller warns so the user
   *  isn't surprised that the run shows up under `deployedSlug`. */
  ignoredFileSlug?: string;
  /** Schema-derivation warnings from the deploy response (additive server field; [] when absent). */
  warnings: string[];
}

export interface DeployContext {
  /** Org slug from `--org` (resolution: --org > single-org credential > link > hard error). */
  orgSlug?: string | undefined;
  /** The original target path (used to locate the project dir for the link). */
  target: string;
  prog: PreparedProgram;
  /** Asked before a deploy that would CREATE a new workflow; return false to abort. Omitted =
   *  no confirmation (the caller already decided, e.g. `--yes`). */
  confirmCreate?: ((info: { slug: string; orgSlug: string }) => Promise<boolean>) | undefined;
}

/** The artifact reference recorded on the version (everything but the bytes, which go to storage). */
function refOf(artifact: BuiltArtifact): DeployArtifactRef {
  return {
    digest: artifact.digest,
    size: artifact.size,
    entry: artifact.entry,
    sdkVersion: artifact.sdkVersion,
    lockfileDigest: artifact.lockfileDigest,
  };
}

/**
 * Deploy the program: resolve the org (Decision 11), honor the project link (update the linked
 * workflow by id — rename-safe), adopt an existing same-slug workflow when unlinked, or — after
 * the create confirmation — create a new one. Always (re)writes the link so the next deploy/run
 * is pinned.
 */
export async function deployWithLink(
  client: BoardwalkClient,
  ctx: DeployContext,
): Promise<DeployResultSummary> {
  const projectDir = projectDirFor(ctx.target);
  const link = readLink(projectDir);
  const credentialOrgs = await fetchCredentialOrgs(client);
  const orgSlug = resolveDeployOrg({
    orgFlag: ctx.orgSlug,
    credentialOrgs,
    linkOrg: link?.orgSlug ?? null,
  });

  // The link's workflow id is only meaningful in the link's own org: when the resolved org differs
  // (a stale link, or an explicit --org elsewhere), fall back to slug matching in the resolved org.
  let workflowId = link !== null && link.orgSlug === orgSlug ? link.workflowId : null;
  let outcome: DeployResultSummary["outcome"] = "updated";

  // Unlinked: adopt an existing workflow with the same slug, if any (so a second machine re-links
  // instead of creating a duplicate). Otherwise we'll create below.
  if (workflowId === null) {
    const match = (await client.listWorkflows(orgSlug)).find((w) => w.slug === ctx.prog.slug);
    if (match !== undefined) {
      workflowId = match.id;
      outcome = "adopted";
    }
  }

  // The create-confirmation gate (Decision 11): asked before ANY write that would create a new
  // workflow; absent confirmCreate means the caller already decided (`--yes`).
  const confirmCreateOrAbort = async (): Promise<void> => {
    if (ctx.confirmCreate === undefined) return;
    const ok = await ctx.confirmCreate({ slug: ctx.prog.slug, orgSlug });
    if (!ok) throw new CliError("Deploy cancelled.");
  };
  if (workflowId === null) await confirmCreateOrAbort();

  // Upload the artifact bytes once (presigned PUT); both create + update reference it by digest.
  const { artifact } = ctx.prog;
  const { uploadUrl, contentType } = await client.getArtifactUploadUrl(orgSlug, {
    digest: artifact.digest,
    size: artifact.size,
  });
  await client.uploadArtifact(uploadUrl, contentType, artifact.tarball);
  const ref = refOf(artifact);

  let result: DeployResult;
  if (workflowId !== null) {
    try {
      result = await client.updateWorkflow(workflowId, ref);
    } catch (err) {
      if (!(err instanceof CliError && err.status === 404)) throw err;
      // The linked workflow was deleted out from under us — recreating is a CREATE, so it goes
      // through the same confirmation before touching the org.
      await confirmCreateOrAbort();
      result = await client.createWorkflow(orgSlug, ref);
      outcome = "created";
    }
  } else {
    result = await client.createWorkflow(orgSlug, ref);
    outcome = "created";
  }
  // The server's workflow row is authoritative for id + slug: on the LINKED path the slug may
  // differ from the descriptor's — we report the server's so a run is never silently attributed
  // to the wrong name (slug is immutable after create).
  workflowId = result.workflow.id;
  const deployedSlug = result.workflow.slug;

  const { gitignoreUpdated } = writeLink(projectDir, { orgSlug, workflowId });
  return {
    workflowId,
    orgSlug,
    versionNumber: result.version.number,
    outcome,
    gitignoreUpdated,
    deployedSlug,
    warnings: result.warnings,
    // Surface a descriptor-slug ≠ deployed-slug mismatch (linked dir points at a different-named workflow).
    ...(deployedSlug !== ctx.prog.slug ? { ignoredFileSlug: ctx.prog.slug } : {}),
  };
}
