// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runBuild } from "./build.js";

function writePkg(pkg: string, slug: string): void {
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(
    join(pkg, "workflow.jsonc"),
    `{ "slug": "${slug}", "triggers": [{ "kind": "manual" }] }`,
  );
  writeFileSync(
    join(pkg, "src", "index.ts"),
    `export default async function run() { return { ok: true }; }`,
  );
}

describe("runBuild", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-build-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the artifact to --out and reports the harvest", async () => {
    writePkg(dir, "my-routine");
    const lines: string[] = [];
    const out = await runBuild(
      { file: dir, out: join(dir, "my-routine.tgz") },
      { log: (l) => lines.push(l) },
    );
    expect(out).toBe(join(dir, "my-routine.tgz"));
    expect(existsSync(out)).toBe(true);
    const joined = lines.join("\n");
    expect(joined).toContain('built "my-routine"');
    expect(joined).toContain("types harvest:"); // packed by default
  });

  it("derives the default output name <slug>.tgz from the descriptor", async () => {
    writePkg(dir, "my-routine");
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const out = await runBuild({ file: dir }, { log: () => undefined });
      // Compare by basename + existence: chdir makes resolve() return the realpath, which differs
      // from the tmp dir on macOS (/var → /private/var).
      expect(out.endsWith(`${sep}my-routine.tgz`)).toBe(true);
      expect(existsSync(out)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it("creates missing parent directories for --out", async () => {
    writePkg(dir, "flow");
    const out = join(dir, "nested", "deep", "flow.tgz");
    await runBuild({ file: dir, out }, { log: () => undefined });
    expect(existsSync(out)).toBe(true);
  });

  it("--no-types-harvest skips the machine layer", async () => {
    writePkg(dir, "lean");
    const lines: string[] = [];
    await runBuild(
      { file: dir, out: join(dir, "lean.tgz"), typesHarvest: false },
      { log: (l) => lines.push(l) },
    );
    expect(lines.join("\n")).not.toContain("types harvest:");
  });

  it("rejects an invalid descriptor before writing anything", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "workflow.jsonc"), `{ "slug": "x" }`); // no triggers
    writeFileSync(join(dir, "src", "index.ts"), `export default async function run() {}`);
    const out = join(dir, "x.tgz");
    await expect(runBuild({ file: dir, out }, { log: () => undefined })).rejects.toThrow(
      /triggers/,
    );
    expect(existsSync(out)).toBe(false);
  });
});
