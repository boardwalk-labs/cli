// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract as tarExtract } from "tar";
import {
  buildArtifact,
  collectAssets,
  globToRegExp,
  lockfileDigest,
  resolveSdkVersion,
  ENTRY_OUTPUT,
  MACHINE_DIR,
  MACHINE_TYPES_DIR,
  SOURCE_DIR,
  UNPINNED_SDK,
} from "./artifact.js";

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

const RUN_PROGRAM = `export default async function run(input: { name?: string }) {
  return { greeting: \`hi \${input.name ?? "world"}\` };
}
`;

/** Scaffold a minimal new-format package: workflow.jsonc + src/index.ts. */
function writePkg(
  pkg: string,
  opts: { slug?: string; descriptor?: string; program?: string } = {},
): void {
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(
    join(pkg, "workflow.jsonc"),
    opts.descriptor ??
      `{
  // starter descriptor
  "slug": "${opts.slug ?? "demo"}",
  "triggers": [{ "kind": "manual" }],
}`,
  );
  writeFileSync(join(pkg, "src", "index.ts"), opts.program ?? RUN_PROGRAM);
}

describe("buildArtifact — the two-file package", () => {
  let dir: string;
  let pkg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-art-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("bundles the entry and packs bundle + descriptor (verbatim) + sources", async () => {
    writePkg(pkg, { slug: "solo-wf" });

    const art = await buildArtifact(pkg, { typesHarvest: false });

    expect(art.entry).toBe(ENTRY_OUTPUT);
    expect(art.slug).toBe("solo-wf"); // from the descriptor — the deploy identity
    expect(art.descriptorFileName).toBe("workflow.jsonc");
    expect(art.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(art.size).toBe(art.tarball.length);
    expect(art.sdkVersion).toBe(UNPINNED_SDK); // no package.json ⇒ unpinned
    expect(art.lockfileDigest).toBeNull();
    expect(art.assetPaths).toEqual([]);

    const out = extractTo(art.tarball, dir);
    expect(existsSync(join(out, "index.mjs"))).toBe(true);
    expect(existsSync(join(out, "index.mjs.map"))).toBe(true);
    // The descriptor ships VERBATIM at the artifact root — comments intact.
    expect(readFileSync(join(out, "workflow.jsonc"), "utf8")).toContain("// starter descriptor");
    // The author's original source, at its package-relative path under .bw-src/.
    expect(readFileSync(join(out, SOURCE_DIR, "src", "index.ts"), "utf8")).toBe(RUN_PROGRAM);
    expect(readFileSync(join(out, "index.mjs"), "utf8")).toContain("greeting");
  });

  it("honors the descriptor's entry field", async () => {
    writePkg(pkg, {
      descriptor: `{ "slug": "custom-entry", "entry": "main.ts", "triggers": [{ "kind": "manual" }] }`,
    });
    rmSync(join(pkg, "src"), { recursive: true, force: true });
    writeFileSync(join(pkg, "main.ts"), `export default async function run() { return 1; }`);

    const art = await buildArtifact(pkg, { typesHarvest: false });
    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, SOURCE_DIR, "main.ts"), "utf8")).toContain("run()");
  });

  it("fails a package with no descriptor, and one with both descriptor spellings", async () => {
    mkdirSync(join(pkg, "src"), { recursive: true });
    writeFileSync(join(pkg, "src", "index.ts"), RUN_PROGRAM);
    await expect(buildArtifact(pkg)).rejects.toThrow(/No workflow\.jsonc/);

    writePkg(pkg);
    writeFileSync(join(pkg, "workflow.json"), `{"slug":"x","triggers":[{"kind":"manual"}]}`);
    await expect(buildArtifact(pkg)).rejects.toThrow(/Both/);
  });

  it("fails a program that does not compile (unresolved import), strip-only otherwise", async () => {
    writePkg(pkg, {
      program: `import { x } from "./does-not-exist.ts";\nexport default async function run() { return x; }`,
    });
    await expect(buildArtifact(pkg, { typesHarvest: false })).rejects.toThrow(/Bundling failed/);

    // Type errors do NOT fail the build — bundling is strip-only, never a type-check.
    writePkg(pkg, {
      program: `const n: number = "not a number" as unknown as number;\nexport default async function run() { return n; }`,
    });
    await expect(buildArtifact(pkg, { typesHarvest: false })).resolves.toBeDefined();
  });

  it("ships the whole source tree under .bw-src/ and inlines local imports into the bundle", async () => {
    writePkg(pkg, {
      program: `import { PLAN } from "../plan.js";\nexport default async function run() { return PLAN; }`,
    });
    writeFileSync(join(pkg, "plan.ts"), `export const PLAN = ["from-plan"];\n`);

    const art = await buildArtifact(pkg, { typesHarvest: false });
    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, SOURCE_DIR, "plan.ts"), "utf8")).toBe(
      `export const PLAN = ["from-plan"];\n`,
    );
    expect(readFileSync(join(out, "index.mjs"), "utf8")).toContain("from-plan");
    // node_modules/dist never land in the stored source tree.
    expect(existsSync(join(out, SOURCE_DIR, "node_modules"))).toBe(false);
  });

  it("is deterministic — same tree ⇒ same digest; an asset change changes it", async () => {
    writePkg(pkg, { slug: "stable" });
    mkdirSync(join(pkg, "skills", "s"), { recursive: true });
    writeFileSync(join(pkg, "skills", "s", "SKILL.md"), "v1");
    const a = await buildArtifact(pkg, { typesHarvest: false });
    const b = await buildArtifact(pkg, { typesHarvest: false });
    expect(a.digest).toBe(b.digest);
    writeFileSync(join(pkg, "skills", "s", "SKILL.md"), "v2");
    const c = await buildArtifact(pkg, { typesHarvest: false });
    expect(c.digest).not.toBe(a.digest);
  });

  it("resolves the SDK version from the package's declared dependency", async () => {
    writePkg(pkg);
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "x", dependencies: { "@boardwalk-labs/workflow": "^1.2.0" } }),
    );
    expect((await buildArtifact(pkg, { typesHarvest: false })).sdkVersion).toBe("^1.2.0");
  });
});

describe("buildArtifact — assets (skills/README convention + files allowlist)", () => {
  let dir: string;
  let pkg: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-art-assets-"));
    pkg = join(dir, "pkg");
    mkdirSync(pkg);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships skills/** and README.md by convention — and nothing else undeclared", async () => {
    writePkg(pkg);
    writeFileSync(join(pkg, "README.md"), "# demo");
    mkdirSync(join(pkg, "skills", "review"), { recursive: true });
    writeFileSync(join(pkg, "skills", "review", "SKILL.md"), "be thorough");
    writeFileSync(join(pkg, "skills", "review", "checklist.txt"), "1) inputs");
    writeFileSync(join(pkg, "notes.md"), "NOT shipped — files is an allowlist");
    writeFileSync(join(pkg, "secrets.json"), `{"token":"nope"}`);

    const art = await buildArtifact(pkg, { typesHarvest: false });
    expect(art.assetPaths).toEqual([
      "README.md",
      "skills/review/SKILL.md",
      "skills/review/checklist.txt",
    ]);
    const out = extractTo(art.tarball, dir);
    expect(readFileSync(join(out, "skills", "review", "SKILL.md"), "utf8")).toBe("be thorough");
    expect(existsSync(join(out, "notes.md"))).toBe(false);
    expect(existsSync(join(out, "secrets.json"))).toBe(false);
  });

  it("ships the descriptor's files globs: a dir, a glob, an exact file", async () => {
    writePkg(pkg, {
      descriptor: `{ "slug": "globs", "triggers": [{ "kind": "manual" }],
        "files": ["prompts/**", "data/seed.json", "fixtures"] }`,
    });
    mkdirSync(join(pkg, "prompts", "deep"), { recursive: true });
    writeFileSync(join(pkg, "prompts", "a.txt"), "a");
    writeFileSync(join(pkg, "prompts", "deep", "b.txt"), "b");
    mkdirSync(join(pkg, "data"));
    writeFileSync(join(pkg, "data", "seed.json"), "{}");
    writeFileSync(join(pkg, "data", "other.json"), "not listed");
    mkdirSync(join(pkg, "fixtures"));
    writeFileSync(join(pkg, "fixtures", "f.csv"), "1,2");

    const art = await buildArtifact(pkg, { typesHarvest: false });
    expect(art.assetPaths).toEqual([
      "data/seed.json",
      "fixtures/f.csv",
      "prompts/a.txt",
      "prompts/deep/b.txt",
    ]);
  });

  it("errors when a files entry matches nothing", async () => {
    writePkg(pkg, {
      descriptor: `{ "slug": "x", "triggers": [{ "kind": "manual" }], "files": ["missing/**"] }`,
    });
    await expect(buildArtifact(pkg, { typesHarvest: false })).rejects.toThrow(/matched nothing/);
  });

  it("NEVER packages dotfiles/.env*/node_modules, whatever the globs say", async () => {
    writePkg(pkg, {
      descriptor: `{ "slug": "x", "triggers": [{ "kind": "manual" }], "files": ["data/**"] }`,
    });
    mkdirSync(join(pkg, "data"));
    writeFileSync(join(pkg, "data", "ok.json"), "{}");
    writeFileSync(join(pkg, "data", ".env"), "SECRET=1");
    writeFileSync(join(pkg, ".env.production"), "SECRET=2");
    mkdirSync(join(pkg, "node_modules", "x"), { recursive: true });
    writeFileSync(join(pkg, "node_modules", "x", "j.md"), "j");

    const art = await buildArtifact(pkg, { typesHarvest: false });
    expect(art.assetPaths).toEqual(["data/ok.json"]);
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

  it("matches the README case-insensitively, keeping its on-disk casing", () => {
    writeFileSync(join(pkg, "readme.md"), "# docs");
    expect(collectAssets(pkg, undefined, "workflow.jsonc").map((a) => a.relPath)).toEqual([
      "readme.md",
    ]);
  });

  it("a nested README is not the landing page — only the root one ships by convention", () => {
    mkdirSync(join(pkg, "docs"));
    writeFileSync(join(pkg, "docs", "README.md"), "nested");
    expect(collectAssets(pkg, undefined, "workflow.jsonc")).toEqual([]);
  });

  it("does not duplicate a conventional file a glob also names", () => {
    mkdirSync(join(pkg, "skills"));
    writeFileSync(join(pkg, "skills", "s.md"), "s");
    expect(collectAssets(pkg, ["skills/**"], "workflow.jsonc").map((a) => a.relPath)).toEqual([
      "skills/s.md",
    ]);
  });

  it("never yields the descriptor itself (it ships verbatim separately)", () => {
    writeFileSync(join(pkg, "workflow.jsonc"), "{}");
    writeFileSync(join(pkg, "data.json"), "{}");
    expect(collectAssets(pkg, ["*.json*"], "workflow.jsonc").map((a) => a.relPath)).toEqual([
      "data.json",
    ]);
  });
});

describe("globToRegExp", () => {
  it("`**` crosses directories; `*`/`?` stay within a segment", () => {
    expect(globToRegExp("prompts/**").test("prompts/a.txt")).toBe(true);
    expect(globToRegExp("prompts/**").test("prompts/deep/b.txt")).toBe(true);
    expect(globToRegExp("prompts/**").test("prompts")).toBe(false);
    expect(globToRegExp("*.json").test("seed.json")).toBe(true);
    expect(globToRegExp("*.json").test("data/seed.json")).toBe(false);
    expect(globToRegExp("**/*.md").test("a/b/x.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("x.md")).toBe(true);
    expect(globToRegExp("file?.txt").test("file1.txt")).toBe(true);
    expect(globToRegExp("file?.txt").test("file10.txt")).toBe(false);
  });

  it("escapes regex metacharacters in literals", () => {
    expect(globToRegExp("a+b(c).txt").test("a+b(c).txt")).toBe(true);
    expect(globToRegExp("a.txt").test("axtxt")).toBe(false);
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

  it("returns UNPINNED for a null dir", () => {
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
    writePkg(pkg, { slug: "typed-wf" });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "typed-wf" }));
    writeFileSync(join(pkg, "tsconfig.json"), `{"compilerOptions":{"strict":true}}`);
    mkdirSync(join(pkg, "node_modules", "foo"), { recursive: true });
    writeFileSync(
      join(pkg, "node_modules", "foo", "package.json"),
      JSON.stringify({ name: "foo", types: "index.d.ts" }),
    );
    writeFileSync(join(pkg, "node_modules", "foo", "index.d.ts"), "export declare const x: 1;\n");
    writeFileSync(join(pkg, "node_modules", "foo", "index.js"), "module.exports = 1;\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is ON by default — the backend derives I/O schemas from it at deploy", async () => {
    const art = await buildArtifact(pkg);
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
    expect(existsSync(join(out, SOURCE_DIR, "node_modules"))).toBe(false);
  });

  it("`typesHarvest: false` (--no-types-harvest) skips the bytes", async () => {
    const art = await buildArtifact(pkg, { typesHarvest: false });
    expect(art.machinePaths).toEqual([]);
    expect(art.machineBytes).toBe(0);
    const out = extractTo(art.tarball, dir);
    expect(existsSync(join(out, MACHINE_DIR))).toBe(false);
  });

  it("is deterministic — same tree ⇒ same digest, and the harvest changes the artifact", async () => {
    const a = await buildArtifact(pkg);
    const b = await buildArtifact(pkg);
    expect(a.digest).toBe(b.digest);
    expect((await buildArtifact(pkg, { typesHarvest: false })).digest).not.toBe(a.digest);
  });
});
