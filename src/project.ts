// Project link — the Vercel-style tie between a local workflow directory and its deployed workflow.
//
// `<projectDir>/.boardwalk/project.json` (gitignored) stores `{ orgSlug, workflowId }`. Once linked,
// `deploy`/`run` update the workflow BY ID — so renaming `meta.name` (or the entry file) just
// updates the same workflow instead of forking a new one, and `--org` is no longer needed. The id is
// environment-specific (a dev workflow id ≠ prod), so the link is gitignored, not committed.
//
// One workflow per project directory (the "a workflow is a package with an index entry" model). The
// project dir is the directory target itself, or the directory containing a single-file entry.

import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ProjectLink {
  orgSlug: string;
  workflowId: string;
}

const LINK_DIR = ".boardwalk";
const LINK_FILE = "project.json";

/** The project directory for a target path: the directory itself, or a file's parent directory. */
export function projectDirFor(target: string): string {
  const abs = resolve(target);
  try {
    if (statSync(abs).isDirectory()) return abs;
  } catch {
    // Missing path — treat the target as a file and use its parent.
  }
  return dirname(abs);
}

/** Read the link for a project dir, or null when absent/malformed. */
export function readLink(projectDir: string): ProjectLink | null {
  let raw: string;
  try {
    raw = readFileSync(join(projectDir, LINK_DIR, LINK_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (typeof p.orgSlug === "string" && typeof p.workflowId === "string") {
        return { orgSlug: p.orgSlug, workflowId: p.workflowId };
      }
    }
  } catch {
    // Malformed → treat as unlinked.
  }
  return null;
}

/**
 * Persist the link and ensure `.boardwalk/` is gitignored. Returns true if it added a `.gitignore`
 * entry (so the caller can mention it). Best-effort on the gitignore side — never fatal.
 */
export function writeLink(projectDir: string, link: ProjectLink): { gitignoreUpdated: boolean } {
  const dir = join(projectDir, LINK_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LINK_FILE), `${JSON.stringify(link, null, 2)}\n`);
  return { gitignoreUpdated: ensureGitignored(projectDir) };
}

function ensureGitignored(projectDir: string): boolean {
  const gitignore = join(projectDir, ".gitignore");
  let content = "";
  try {
    content = readFileSync(gitignore, "utf8");
  } catch {
    // No .gitignore yet — we'll create one.
  }
  if (/^\.boardwalk\/?\s*$/m.test(content)) return false;
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  try {
    writeFileSync(gitignore, `${content}${prefix}.boardwalk/\n`);
    return true;
  } catch {
    return false; // best-effort: a read-only dir shouldn't break deploy
  }
}
