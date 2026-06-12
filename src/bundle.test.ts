import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleWorkflow, resolveEntry, isPackageDir } from "./bundle.js";
import { extractWorkflowName } from "./manifest.js";

describe("isPackageDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-bundle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true for a directory, false for a file", () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, "export const meta = { name: 'x' };");
    expect(isPackageDir(dir)).toBe(true);
    expect(isPackageDir(file)).toBe(false);
  });

  it("is false for a missing path", () => {
    expect(isPackageDir(join(dir, "nope"))).toBe(false);
  });
});

describe("resolveEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-entry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a file path unchanged", () => {
    const file = join(dir, "wf.ts");
    writeFileSync(file, "export const meta = { name: 'x' };");
    expect(resolveEntry(file)).toBe(file);
  });

  it("resolves index.ts inside a directory", () => {
    writeFileSync(join(dir, "index.ts"), "export const meta = { name: 'x' };");
    expect(resolveEntry(dir)).toBe(join(dir, "index.ts"));
  });

  it("honors package.json module/main", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ module: "main.ts" }));
    writeFileSync(join(dir, "main.ts"), "export const meta = { name: 'x' };");
    expect(resolveEntry(dir)).toBe(join(dir, "main.ts"));
  });

  it("throws for a directory with no entry", () => {
    expect(() => resolveEntry(dir)).toThrow(/No entry file/);
  });

  it("throws for a missing path", () => {
    expect(() => resolveEntry(join(dir, "ghost"))).toThrow(/not found/);
  });
});

describe("bundleWorkflow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-bundlewf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlines a local dependency and leaves @boardwalk-labs/workflow external", async () => {
    writeFileSync(join(dir, "helper.ts"), `export const GREETING = "from-helper";`);
    const entry = join(dir, "index.ts");
    writeFileSync(
      entry,
      `import { agent } from "@boardwalk-labs/workflow";
       import { GREETING } from "./helper.ts";
       export const meta = { name: "bundled-wf", description: "d" };
       await agent(GREETING, undefined);`,
    );

    const out = await bundleWorkflow(entry);
    // Local dep is inlined (its value present), SDK import is preserved as an external import.
    expect(out).toContain("from-helper");
    expect(out).toMatch(/from\s*"@boardwalk-labs\/workflow"/);
    expect(out).not.toContain("./helper");
  });

  it("keeps meta statically extractable from the bundle output", async () => {
    const entry = join(dir, "index.ts");
    writeFileSync(
      entry,
      `import { sleep } from "@boardwalk-labs/workflow";
       export const meta = { name: "still-extractable", description: "d" };
       await sleep(1);`,
    );
    const out = await bundleWorkflow(entry);
    // The backend re-derives the manifest from the uploaded (bundled) source — name must survive.
    expect(extractWorkflowName(out, "bundle.js")).toBe("still-extractable");
  });

  it("resolves and bundles a package directory via its entry", async () => {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "index.ts"), `export const meta = { name: "pkg-wf" };`);
    const out = await bundleWorkflow(resolveEntry(join(dir, "pkg")));
    expect(extractWorkflowName(out, "bundle.js")).toBe("pkg-wf");
  });
});
