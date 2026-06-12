import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectDirFor, readLink, writeLink } from "./project.js";

describe("projectDirFor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-proj-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a directory target as-is", () => {
    expect(projectDirFor(dir)).toBe(dir);
  });

  it("returns the parent directory for a file target", () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, "x");
    expect(projectDirFor(file)).toBe(dir);
  });

  it("treats a missing path as a file (uses its parent)", () => {
    expect(projectDirFor(join(dir, "ghost.ts"))).toBe(dir);
  });
});

describe("readLink / writeLink", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-link-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when unlinked", () => {
    expect(readLink(dir)).toBeNull();
  });

  it("round-trips a link", () => {
    writeLink(dir, { orgSlug: "my-team", workflowId: "01HQ" });
    expect(readLink(dir)).toEqual({ orgSlug: "my-team", workflowId: "01HQ" });
  });

  it("creates a .gitignore entry for .boardwalk/ and reports it", () => {
    const res = writeLink(dir, { orgSlug: "o", workflowId: "w" });
    expect(res.gitignoreUpdated).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain(".boardwalk/");
    expect(existsSync(join(dir, ".boardwalk", "project.json"))).toBe(true);
  });

  it("does not duplicate the .gitignore entry on a second write", () => {
    writeLink(dir, { orgSlug: "o", workflowId: "w" });
    const res = writeLink(dir, { orgSlug: "o", workflowId: "w2" });
    expect(res.gitignoreUpdated).toBe(false);
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi.match(/\.boardwalk\//g)).toHaveLength(1);
    expect(readLink(dir)?.workflowId).toBe("w2");
  });

  it("appends to an existing .gitignore without clobbering it", () => {
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    writeLink(dir, { orgSlug: "o", workflowId: "w" });
    const gi = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gi).toContain("node_modules");
    expect(gi).toContain(".boardwalk/");
  });

  it("returns null for a malformed link file", () => {
    writeLink(dir, { orgSlug: "o", workflowId: "w" });
    writeFileSync(join(dir, ".boardwalk", "project.json"), "{ not json");
    expect(readLink(dir)).toBeNull();
  });
});
