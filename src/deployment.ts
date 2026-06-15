// SPDX-License-Identifier: MIT

// Shared deploy logic for `boardwalk deploy` and `boardwalk run`.
//
// Deploy is artifact-based: build the program into a content-addressed tarball, upload it straight
// to object storage via a presigned PUT (the CLI holds no storage credentials), then finalize the
// version with a reference the server re-reads + verifies. Identity is the project LINK
// (.boardwalk/project.json), not the program name. Both commands:
//   1. build the program artifact (name from its `meta`),
//   2. resolve the org (--org, else the link's orgSlug),
//   3. upload the artifact, then update the linked workflow BY ID (rename-safe) — or, when unlinked,
//      adopt an existing same-name workflow / create a new one — then (re)write the link.

import { CliError } from "./errors.js";
import { extractWorkflowSlug } from "./manifest.js";
import { buildArtifact, type BuiltArtifact } from "./artifact.js";
import { projectDirFor, readLink, writeLink } from "./project.js";
import type { BoardwalkClient, DeployArtifactRef, WorkflowSummary } from "./client.js";

export interface PreparedProgram {
  slug: string;
  /** Entry module inside the artifact (e.g. `index.mjs`). */
  entry: string;
  /** The built, content-addressed program artifact (tarball + digest + metadata). */
  artifact: BuiltArtifact;
}

/**
 * Resolve a target path to its deployable artifact: build the program (bundle + assets → tarball,
 * content-addressed) and extract `meta.slug` from the bundled entry for the deploy identity.
 */
export async function loadProgram(file: string): Promise<PreparedProgram> {
  const artifact = await buildArtifact(file);
  const slug = extractWorkflowSlug(artifact.entrySource, artifact.entry);
  return { slug, entry: artifact.entry, artifact };
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

export interface DeployResultSummary {
  workflowId: string;
  orgSlug: string;
  versionNumber: number;
  /** "created" a new workflow, "updated" the linked one, or "adopted" an existing same-name one. */
  outcome: "created" | "updated" | "adopted";
  /** True when this deploy wrote a `.gitignore` entry for `.boardwalk/`. */
  gitignoreUpdated: boolean;
}

export interface DeployContext {
  /** Org slug from `--org`; falls back to the link's orgSlug. */
  orgSlug?: string | undefined;
  /** The original target path (used to locate the project dir for the link). */
  target: string;
  prog: PreparedProgram;
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
 * Deploy the program, honoring the project link: upload the artifact, then update the linked workflow
 * by id (rename-safe); when unlinked, adopt an existing same-name workflow or create a new one. Always
 * (re)writes the link so the next deploy/run is pinned.
 */
export async function deployWithLink(
  client: BoardwalkClient,
  ctx: DeployContext,
): Promise<DeployResultSummary> {
  const projectDir = projectDirFor(ctx.target);
  const link = readLink(projectDir);
  const orgSlug = ctx.orgSlug ?? link?.orgSlug;
  if (orgSlug === undefined || orgSlug.length === 0) {
    throw new CliError(
      "No org to deploy into.",
      "Pass --org <slug> (it'll be linked in .boardwalk/project.json for next time).",
    );
  }

  let workflowId = link?.workflowId ?? null;
  let outcome: DeployResultSummary["outcome"] = "updated";

  // Unlinked: adopt an existing workflow with the same name, if any (so a second machine re-links
  // instead of creating a duplicate). Otherwise we'll create below.
  if (workflowId === null) {
    const match = (await client.listWorkflows(orgSlug)).find((w) => w.slug === ctx.prog.slug);
    if (match !== undefined) {
      workflowId = match.id;
      outcome = "adopted";
    }
  }

  // Upload the artifact bytes once (presigned PUT); both create + update reference it by digest.
  const { artifact } = ctx.prog;
  const { uploadUrl, contentType } = await client.getArtifactUploadUrl(orgSlug, {
    digest: artifact.digest,
    size: artifact.size,
  });
  await client.uploadArtifact(uploadUrl, contentType, artifact.tarball);
  const ref = refOf(artifact);

  let versionNumber: number;
  if (workflowId !== null) {
    try {
      const result = await client.updateWorkflow(workflowId, ref);
      versionNumber = result.version.number;
    } catch (err) {
      if (err instanceof CliError && err.status === 404) {
        // The linked workflow was deleted out from under us — recreate + relink.
        const result = await client.createWorkflow(orgSlug, ref);
        workflowId = result.workflow.id;
        versionNumber = result.version.number;
        outcome = "created";
      } else {
        throw err;
      }
    }
  } else {
    const result = await client.createWorkflow(orgSlug, ref);
    workflowId = result.workflow.id;
    versionNumber = result.version.number;
    outcome = "created";
  }

  const { gitignoreUpdated } = writeLink(projectDir, { orgSlug, workflowId });
  return { workflowId, orgSlug, versionNumber, outcome, gitignoreUpdated };
}
