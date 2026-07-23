// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./check.js";

function writePkg(dir: string, descriptor: string, program?: string): void {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "workflow.jsonc"), descriptor);
  writeFileSync(
    join(dir, "src", "index.ts"),
    program ?? `export default async function run() { return "ok"; }`,
  );
}

describe("runCheck", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a valid package and reports slug + triggers + secrets + harvest + derive note", async () => {
    writePkg(
      dir,
      `{
         "slug": "ok-wf",
         "description": "d",
         "triggers": [{ "kind": "manual" }, { "kind": "cron", "expr": "0 9 * * 1-5" }],
         "permissions": { "secrets": [{ "name": "API_KEY" }] },
       }`,
    );
    const lines: string[] = [];
    await runCheck({ file: dir }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain('"ok-wf" is valid');
    expect(out).toContain("manual, cron");
    expect(out).toContain("API_KEY");
    expect(out).toContain("types harvest:"); // ON by default for the new format
    // No local derivation — check is honest that schemas come back from the deploy.
    expect(out).toContain("derive at deploy");
  });

  it("--no-types-harvest skips the harvest line", async () => {
    writePkg(dir, `{ "slug": "lean", "triggers": [{ "kind": "manual" }] }`);
    const lines: string[] = [];
    await runCheck({ file: dir, typesHarvest: false }, { log: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toContain("types harvest:");
  });

  it("fails a package with no descriptor", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), `export default async function run() {}`);
    await expect(runCheck({ file: dir }, { log: () => undefined })).rejects.toThrow(
      /No workflow\.jsonc/,
    );
  });

  it("fails when both descriptor spellings exist", async () => {
    writePkg(dir, `{ "slug": "x", "triggers": [{ "kind": "manual" }] }`);
    writeFileSync(join(dir, "workflow.json"), `{"slug":"x","triggers":[{"kind":"manual"}]}`);
    await expect(runCheck({ file: dir }, { log: () => undefined })).rejects.toThrow(/Both/);
  });

  it("fails a descriptor-schema violation (missing triggers)", async () => {
    writePkg(dir, `{ "slug": "no-triggers" }`);
    await expect(runCheck({ file: dir }, { log: () => undefined })).rejects.toThrow(/triggers/);
  });

  it("fails a hand-written input_schema — schemas are derived, never authored", async () => {
    writePkg(
      dir,
      `{ "slug": "x", "triggers": [{ "kind": "manual" }], "input_schema": {"type":"object"} }`,
    );
    await expect(runCheck({ file: dir }, { log: () => undefined })).rejects.toThrow(/input_schema/);
  });

  it("fails a program that does not compile (unresolved import)", async () => {
    writePkg(
      dir,
      `{ "slug": "broken", "triggers": [{ "kind": "manual" }] }`,
      `import { x } from "./does-not-exist.ts";
       export default async function run() { return x; }`,
    );
    await expect(runCheck({ file: dir }, { log: () => undefined })).rejects.toThrow(
      /Bundling failed/,
    );
  });
});
