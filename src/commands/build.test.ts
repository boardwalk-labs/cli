import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { runBuild } from "./build.js";

const WORKFLOW = `import { output } from "@boardwalk-labs/workflow";
export const meta = { name: "my-routine", triggers: [{ kind: "manual" }] };
output({ ok: true });`;

describe("runBuild", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-build-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("bundles to <name>.mjs by default, SDK left external, meta intact", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, WORKFLOW);

    const out = await runBuild(
      { file, out: join(dir, "my-routine.mjs") },
      { log: () => undefined },
    );

    expect(out).toBe(join(dir, "my-routine.mjs"));
    const built = readFileSync(out, "utf8");
    // @boardwalk-labs/workflow stays an external import (the engine resolves its own copy) —
    // it must NOT be inlined, or the program would load a second SDK instance.
    expect(built).toContain('from "@boardwalk-labs/workflow"');
    // The pure-literal meta survives so engines can re-derive the manifest.
    expect(built).toContain('name: "my-routine"');
  });

  it("derives the default output name from the manifest", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, WORKFLOW);
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const out = await runBuild({ file }, { log: () => undefined });
      // Default name = the manifest name in the cwd. Compare by basename + existence: chdir makes
      // resolve() return the realpath, which differs from the tmp dir on macOS (/var → /private/var).
      expect(out.endsWith(`${sep}my-routine.mjs`)).toBe(true);
      expect(existsSync(out)).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it("creates missing parent directories for --out", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, WORKFLOW);
    const out = join(dir, "nested", "deep", "flow.mjs");

    await runBuild({ file, out }, { log: () => undefined });
    expect(existsSync(out)).toBe(true);
  });

  it("rejects an invalid manifest before writing anything", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, `export const meta = { name: "x" };`); // no triggers
    const out = join(dir, "x.mjs");

    await expect(runBuild({ file, out }, { log: () => undefined })).rejects.toThrow(/triggers/);
    expect(existsSync(out)).toBe(false);
  });
});
