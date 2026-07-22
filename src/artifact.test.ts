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
  MACHINE_DIR,
  MACHINE_TYPES_DIR,
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

  it("ships a README beside a lone entry — the README always ships", async () => {
    // The docs tell authors to put a README "next to your index.ts", so a lone-file deploy has to
    // honour that too, not just `deploy .`. Nothing reads a README at run time, so including it can
    // never change how the program behaves.
    const entry = join(dir, "index.ts");
    writeFileSync(entry, `export const meta = { slug: "solo", description: "d" };\nawait 0;`);
    writeFileSync(join(dir, "README.md"), "# solo");

    const art = await buildArtifact(entry);

    expect(art.assetPaths).toEqual(["README.md"]);
    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("# solo");
  });

  it("ships ONLY the README beside a lone entry — never a directory sweep", async () => {
    // The whole point of the lone-file mode: `boardwalk deploy ~/scratch/index.ts` must not publish
    // everything in ~/scratch. One known filename is not a sweep; anything else beside it stays put.
    const entry = join(dir, "index.ts");
    writeFileSync(entry, `export const meta = { slug: "solo", description: "d" };\nawait 0;`);
    writeFileSync(join(dir, "README.md"), "# solo");
    writeFileSync(join(dir, "secrets.json"), `{"token":"nope"}`);
    writeFileSync(join(dir, "notes.md"), "unrelated");
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeFileSync(join(dir, "skills", "review.md"), "not shipped by a lone file");

    expect((await buildArtifact(entry)).assetPaths).toEqual(["README.md"]);
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

  it("ships the package's WHOLE source tree under .bw-src/, not just the entry", async () => {
    // Regression: only the entry was stored, so a dashboard code view showed an `index.ts` importing
    // a `./plan.js` it could not display or round-trip — and the platform held no copy of the sibling.
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "tree-wf" }));
    writeFileSync(join(pkg, "plan.ts"), `export const PLAN = ["a"];\n`);
    mkdirSync(join(pkg, "lib"), { recursive: true });
    writeFileSync(join(pkg, "lib", "util.ts"), `export const U = 1;\n`);
    writeFileSync(
      join(pkg, "index.ts"),
      `import { PLAN } from "./plan.js";
import { U } from "./lib/util.js";
export const meta = { slug: "tree-wf", description: "d" };
void PLAN; void U;`,
    );

    const out = extractTo((await buildArtifact(pkg)).tarball, dir);
    expect(readFileSync(join(out, ".bw-src", "index.ts"), "utf8")).toContain(`from "./plan.js"`);
    expect(readFileSync(join(out, ".bw-src", "plan.ts"), "utf8")).toBe(
      `export const PLAN = ["a"];\n`,
    );
    // Nested sources keep their relative path, so the tree's own imports still resolve.
    expect(readFileSync(join(out, ".bw-src", "lib", "util.ts"), "utf8")).toBe(
      `export const U = 1;\n`,
    );
    // The runtime is unchanged: the runner still imports the single bundled entry.
    expect(existsSync(join(out, "index.mjs"))).toBe(true);
  });

  it("keeps build output and node_modules out of the stored source tree", async () => {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "clean-wf" }));
    mkdirSync(join(pkg, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "left-pad", "index.js"), `module.exports = 1;`);
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "dist", "index.js"), `console.log("built");`);
    writeFileSync(
      join(pkg, "index.ts"),
      `export const meta = { slug: "clean-wf", description: "d" };\nawait 0;`,
    );

    const out = extractTo((await buildArtifact(pkg)).tarball, dir);
    expect(existsSync(join(out, ".bw-src", "index.ts"))).toBe(true);
    expect(existsSync(join(out, ".bw-src", "node_modules"))).toBe(false);
    expect(existsSync(join(out, ".bw-src", "dist"))).toBe(false);
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
    mkdirSync(join(pkg, "skills", "review"), { recursive: true });
    writeFileSync(join(pkg, "skills", "review", "SKILL.md"), "# Review skill\nbe thorough");
    writeFileSync(join(pkg, "skills", "review", "checklist.txt"), "1) check inputs");
    writeFileSync(join(pkg, "config.json"), `{"k":"v"}`);

    const art = await buildArtifact(pkg);

    // The whole folder-per-skill subtree rides the artifact — SKILL.md AND its bundled resource.
    expect([...art.assetPaths].sort()).toEqual(
      ["config.json", "skills/review/SKILL.md", "skills/review/checklist.txt"].sort(),
    );
    expect(art.sdkVersion).toBe("^1.2.0"); // from the declared dependency range
    expect(art.entrySource).toContain("from-helper"); // local dep inlined into the bundle

    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, "skills", "review", "SKILL.md"), "utf8")).toContain(
      "be thorough",
    );
    expect(readFileSync(join(out, "skills", "review", "checklist.txt"), "utf8")).toBe(
      "1) check inputs",
    );
    expect(readFileSync(join(out, "config.json"), "utf8")).toBe(`{"k":"v"}`);
    expect(existsSync(join(out, "index.mjs"))).toBe(true);
    // Source + config are NOT shipped raw — only the bundle + declared assets.
    expect(existsSync(join(out, "helper.ts"))).toBe(false);
    expect(existsSync(join(out, "package.json"))).toBe(false);
  });

  it("changes the digest when an asset changes (content addressing)", async () => {
    writeFileSync(join(pkg, "index.ts"), `export const meta = { slug: "cad", description: "d" };`);
    mkdirSync(join(pkg, "skills", "s"), { recursive: true });
    writeFileSync(join(pkg, "skills", "s", "SKILL.md"), "v1");
    const a = await buildArtifact(pkg);
    writeFileSync(join(pkg, "skills", "s", "SKILL.md"), "v2");
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
    mkdirSync(join(pkg, "skills", "review"), { recursive: true });
    writeFileSync(join(pkg, "skills", "review", "SKILL.md"), "s"); // nested skill — kept
    writeFileSync(join(pkg, "skills", "review", "ref.txt"), "r"); // nested resource — kept
    mkdirSync(join(pkg, "node_modules"));
    writeFileSync(join(pkg, "node_modules", "junk.md"), "j"); // pruned dir

    expect([...collectAssets(pkg).map((a) => a.relPath)].sort()).toEqual(
      ["prompt.md", "skills/review/SKILL.md", "skills/review/ref.txt"].sort(),
    );
  });

  it("keeps a root README.md — it's a workflow's landing prose, not a build file", () => {
    // A dashboard renders this as the workflow's front page, so the default rule shipping it is a
    // contract, not an accident: sorting README.md in with package.json/tsconfig as "not runtime"
    // would silently blank that page. It rides along as an ordinary asset — no special casing.
    writeFileSync(join(pkg, "index.ts"), "x");
    writeFileSync(join(pkg, "README.md"), "# what this workflow does");

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["README.md"]);
  });

  it("ships the README even when an explicit boardwalk.assets list omits it", () => {
    // `boardwalk.assets` scopes what the PROGRAM may read at run time; it doesn't get to decide what
    // DOCUMENTS the workflow. Before this, `assets: ["skills"]` silently blanked the landing page.
    // (npm pack does the same: README/LICENSE/package.json ship whatever `files` says.)
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ boardwalk: { assets: ["skills"] } }));
    writeFileSync(join(pkg, "README.md"), "# docs");
    writeFileSync(join(pkg, "ignored.md"), "not listed, not shipped");
    mkdirSync(join(pkg, "skills"));
    writeFileSync(join(pkg, "skills", "review.md"), "s");

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["README.md", "skills/review.md"]);
  });

  it("does not duplicate a README an explicit list already names", () => {
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ boardwalk: { assets: ["README.md"] } }),
    );
    writeFileSync(join(pkg, "README.md"), "# docs");

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["README.md"]);
  });

  it("matches the README case-insensitively, keeping its on-disk casing", () => {
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ boardwalk: { assets: [] } }));
    writeFileSync(join(pkg, "readme.md"), "# docs");

    expect(collectAssets(pkg).map((a) => a.relPath)).toEqual(["readme.md"]);
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

describe("buildArtifact — machine layer (types harvest)", () => {
  let dir: string;
  let pkg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-art-machine-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typed-wf" }));
    writeFileSync(join(pkg, "tsconfig.json"), `{"compilerOptions":{"strict":true}}`);
    mkdirSync(join(pkg, "node_modules", "foo"), { recursive: true });
    writeFileSync(
      join(pkg, "node_modules", "foo", "package.json"),
      JSON.stringify({ name: "foo", types: "index.d.ts" }),
    );
    writeFileSync(join(pkg, "node_modules", "foo", "index.d.ts"), "export declare const x: 1;\n");
    writeFileSync(join(pkg, "node_modules", "foo", "index.js"), "module.exports = 1;\n");
    writeFileSync(
      join(pkg, "index.ts"),
      `export const meta = { slug: "typed-wf", description: "d" };\nawait 0;`,
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is OFF by default — no .bw-machine/ entries, empty machinePaths", async () => {
    const art = await buildArtifact(pkg);
    expect(art.machinePaths).toEqual([]);
    expect(art.machineBytes).toBe(0);
    const out = extractTo(art.tarball, dir);
    expect(existsSync(join(out, MACHINE_DIR))).toBe(false);
  });

  it("packs the harvest under .bw-machine/types/ at project-relative paths when opted in", async () => {
    const art = await buildArtifact(pkg, { typesHarvest: true });
    expect(art.machinePaths).toEqual([
      `${MACHINE_TYPES_DIR}/node_modules/foo/index.d.ts`,
      `${MACHINE_TYPES_DIR}/node_modules/foo/package.json`,
      `${MACHINE_TYPES_DIR}/package.json`,
      `${MACHINE_TYPES_DIR}/tsconfig.json`,
    ]);
    expect(art.machineBytes).toBeGreaterThan(0);

    const out = extractTo(art.tarball, dir);
    // Declarations + package metadata + tsconfig ship byte-exact; runtime JS does not.
    expect(
      readFileSync(join(out, MACHINE_TYPES_DIR, "node_modules", "foo", "index.d.ts"), "utf8"),
    ).toBe("export declare const x: 1;\n");
    expect(existsSync(join(out, MACHINE_TYPES_DIR, "node_modules", "foo", "index.js"))).toBe(false);
    // The machine layer never leaks into the author layer.
    expect(existsSync(join(out, ".bw-src", "node_modules"))).toBe(false);
    expect((await buildArtifact(pkg)).assetPaths).toEqual([]);
  });

  it("is deterministic — same tree ⇒ same digest, with and without the harvest", async () => {
    const a = await buildArtifact(pkg, { typesHarvest: true });
    const b = await buildArtifact(pkg, { typesHarvest: true });
    expect(a.digest).toBe(b.digest);
    // And the harvest changes the artifact (it's real content, not metadata).
    expect((await buildArtifact(pkg)).digest).not.toBe(a.digest);
  });

  it("a dependency-free package harvests just its tsconfig + package.json — valid, not an error", async () => {
    rmSync(join(pkg, "node_modules"), { recursive: true, force: true });
    const art = await buildArtifact(pkg, { typesHarvest: true });
    expect(art.machinePaths).toEqual([
      `${MACHINE_TYPES_DIR}/package.json`,
      `${MACHINE_TYPES_DIR}/tsconfig.json`,
    ]);
  });

  it("rejects an explicit boardwalk.assets entry under the reserved .bw-machine/ namespace", async () => {
    mkdirSync(join(pkg, ".bw-machine"), { recursive: true });
    writeFileSync(join(pkg, ".bw-machine", "spoof.txt"), "nope");
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "typed-wf", boardwalk: { assets: [".bw-machine"] } }),
    );
    await expect(buildArtifact(pkg)).rejects.toThrow(/Reserved path/);
  });
});
