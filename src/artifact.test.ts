// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract as tarExtract } from "tar";
import {
  buildArtifact,
  collectAssets,
  lockfileDigest,
  resolveSdkVersion,
  ENTRY_OUTPUT,
  SOURCE_FILE,
  UNPINNED_SDK,
} from "./artifact.js";
import { extractWorkflowSlug } from "./manifest.js";

/** Extract a `.tgz` buffer into a fresh dir and return it (for asserting artifact contents). */
function extractTo(tarball: Uint8Array, dir: string): string {
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  const tgz = join(dir, "artifact.tgz");
  writeFileSync(tgz, tarball);
  // Synchronous extract so the dir is populated before we assert.
  tarExtract({ file: tgz, cwd: out, sync: true });
  return out;
}

describe("buildArtifact — single file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-art-file-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a content-addressed tarball with the bundled entry + sourcemap", async () => {
    const entry = join(dir, "wf.ts");
    writeFileSync(
      entry,
      `import { sleep } from "@boardwalk-labs/workflow";
       export const meta = { slug: "solo-wf", description: "d" };
       await sleep(1);`,
    );

    const art = await buildArtifact(entry);

    expect(art.entry).toBe(ENTRY_OUTPUT);
    expect(art.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(art.size).toBe(art.tarball.length);
    expect(art.size).toBeGreaterThan(0);
    expect(art.sdkVersion).toBe(UNPINNED_SDK); // no package.json ⇒ unpinned
    expect(art.lockfileDigest).toBeNull();
    expect(art.assetPaths).toEqual([]);
    // meta survives bundling so the backend can re-derive the manifest from the entry.
    expect(extractWorkflowSlug(art.entrySource, "index.mjs")).toBe("solo-wf");

    const out = extractTo(art.tarball, dir);
    expect(existsSync(join(out, "index.mjs"))).toBe(true);
    expect(existsSync(join(out, "index.mjs.map"))).toBe(true);
    expect(readFileSync(join(out, "index.mjs"), "utf8")).toContain("solo-wf");
  });

  it("stores the author's ORIGINAL source verbatim (blank lines intact) for the Code tab", async () => {
    const entry = join(dir, "wf.ts");
    const original = `export const meta = { slug: "spaced", description: "d" };

import { agent } from "@boardwalk-labs/workflow";

// breathing room
await agent("go");
`;
    writeFileSync(entry, original);
    const art = await buildArtifact(entry);
    const out = extractTo(art.tarball, dir);
    // The built entry is reformatted (no blank lines); the stored source is byte-for-byte the author's.
    expect(readFileSync(join(out, SOURCE_FILE), "utf8")).toBe(original);
    expect(readFileSync(join(out, SOURCE_FILE), "utf8")).toContain("\n\n");
  });

  it("is deterministic — same source ⇒ same digest", async () => {
    const entry = join(dir, "wf.ts");
    writeFileSync(
      entry,
      `import { agent } from "@boardwalk-labs/workflow";
       export const meta = { slug: "stable", description: "d" };
       await agent("hi", { model: "anthropic/claude-sonnet-4.5" });`,
    );
    const a = await buildArtifact(entry);
    const b = await buildArtifact(entry);
    expect(a.digest).toBe(b.digest);
  });
});

describe("buildArtifact — package with assets", () => {
  let dir: string;
  let pkg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-art-pkg-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlines local deps, ships assets at their relative paths, resolves the SDK version", async () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "pkg-wf", dependencies: { "@boardwalk-labs/workflow": "^1.2.0" } }),
    );
    writeFileSync(join(pkg, "helper.ts"), `export const GREETING = "from-helper";`);
    writeFileSync(
      join(pkg, "index.ts"),
      `import { agent } from "@boardwalk-labs/workflow";
       import { GREETING } from "./helper.ts";
       export const meta = { slug: "pkg-wf", description: "d" };
       await agent(GREETING, { model: "anthropic/claude-sonnet-4.5" });`,
    );
    mkdirSync(join(pkg, "skills"));
    writeFileSync(join(pkg, "skills", "review.md"), "# Review skill\nbe thorough");
    writeFileSync(join(pkg, "config.json"), `{"k":"v"}`);

    const art = await buildArtifact(pkg);

    expect(art.assetPaths).toEqual(["config.json", "skills/review.md"]);
    expect(art.sdkVersion).toBe("^1.2.0"); // from the declared dependency range
    expect(art.entrySource).toContain("from-helper"); // local dep inlined into the bundle

    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, "skills", "review.md"), "utf8")).toContain("be thorough");
    expect(readFileSync(join(out, "config.json"), "utf8")).toBe(`{"k":"v"}`);
    expect(existsSync(join(out, "index.mjs"))).toBe(true);
    // Source + config are NOT shipped raw — only the bundle + declared assets.
    expect(existsSync(join(out, "helper.ts"))).toBe(false);
    expect(existsSync(join(out, "package.json"))).toBe(false);
  });

  it("changes the digest when an asset changes (content addressing)", async () => {
    writeFileSync(join(pkg, "index.ts"), `export const meta = { slug: "cad", description: "d" };`);
    mkdirSync(join(pkg, "skills"));
    writeFileSync(join(pkg, "skills", "s.md"), "v1");
    const a = await buildArtifact(pkg);
    writeFileSync(join(pkg, "skills", "s.md"), "v2");
    const b = await buildArtifact(pkg);
    expect(a.digest).not.toBe(b.digest);
  });
});

describe("collectAssets", () => {
  let pkg: string;
  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "bw-assets-"));
  });
  afterEach(() => {
    rmSync(pkg, { recursive: true, force: true });
  });

  it("default rule keeps non-source files and prunes node_modules/source/config/dotfiles", () => {
    writeFileSync(join(pkg, "index.ts"), "x"); // source — excluded
    writeFileSync(join(pkg, "package.json"), "{}"); // config — excluded
    writeFileSync(join(pkg, "pnpm-lock.yaml"), "lock"); // lockfile — excluded
    writeFileSync(join(pkg, ".env"), "SECRET=1"); // dotfile — excluded
    writeFileSync(join(pkg, "prompt.md"), "p"); // asset — kept
    mkdirSync(join(pkg, "skills"));
    writeFileSync(join(pkg, "skills", "a.md"), "a"); // nested asset — kept
    mkdirSync(join(pkg, "node_modules"));
    writeFileSync(join(pkg, "node_modules", "junk.md"), "j"); // pruned dir

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["prompt.md", "skills/a.md"]);
  });

  it("honors an explicit boardwalk.assets list (files + dirs) and ignores everything else", () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ boardwalk: { assets: ["prompts", "data.json"] } }),
    );
    writeFileSync(join(pkg, "data.json"), "{}");
    writeFileSync(join(pkg, "ignored.md"), "no"); // not listed ⇒ excluded
    mkdirSync(join(pkg, "prompts"));
    writeFileSync(join(pkg, "prompts", "x.txt"), "x");

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["data.json", "prompts/x.txt"]);
  });

  it("throws when a boardwalk.assets entry does not exist", () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ boardwalk: { assets: ["missing.md"] } }),
    );
    expect(() => collectAssets(pkg)).toThrow(/not found/);
  });
});

describe("resolveSdkVersion", () => {
  let pkg: string;
  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "bw-sdkver-"));
  });
  afterEach(() => {
    rmSync(pkg, { recursive: true, force: true });
  });

  it("returns UNPINNED for a null dir (single file)", () => {
    expect(resolveSdkVersion(null)).toBe(UNPINNED_SDK);
  });

  it("prefers the installed version over the declared range", () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ dependencies: { "@boardwalk-labs/workflow": "^1.0.0" } }),
    );
    mkdirSync(join(pkg, "node_modules", "@boardwalk-labs", "workflow"), { recursive: true });
    writeFileSync(
      join(pkg, "node_modules", "@boardwalk-labs", "workflow", "package.json"),
      JSON.stringify({ version: "1.4.2" }),
    );
    expect(resolveSdkVersion(pkg)).toBe("1.4.2");
  });

  it("falls back to the declared range, then UNPINNED", () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ devDependencies: { "@boardwalk-labs/workflow": "2.0.0-beta" } }),
    );
    expect(resolveSdkVersion(pkg)).toBe("2.0.0-beta");

    rmSync(join(pkg, "package.json"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "no-sdk" }));
    expect(resolveSdkVersion(pkg)).toBe(UNPINNED_SDK);
  });
});

describe("lockfileDigest", () => {
  let pkg: string;
  beforeEach(() => {
    pkg = mkdtempSync(join(tmpdir(), "bw-lock-"));
  });
  afterEach(() => {
    rmSync(pkg, { recursive: true, force: true });
  });

  it("hashes the lockfile when present, null otherwise", () => {
    expect(lockfileDigest(pkg)).toBeNull();
    writeFileSync(join(pkg, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    expect(lockfileDigest(pkg)).toMatch(/^[0-9a-f]{64}$/);
  });
});
