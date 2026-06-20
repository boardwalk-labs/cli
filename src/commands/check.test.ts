// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "./check.js";

describe("runCheck", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-check-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes a valid single-file workflow and reports its name + triggers", async () => {
    const file = join(dir, "wf.ts");
    writeFileSync(
      file,
      `export const meta = {
         slug: "ok-wf",
         description: "d",
         triggers: [{ kind: "manual" }, { kind: "cron", expr: "0 9 * * 1-5" }],
         permissions: { secrets: [{ name: "API_KEY" }] },
       };
       console.log("ok-wf would run here");`,
    );
    const lines: string[] = [];
    await runCheck({ file }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain('"ok-wf" is valid');
    expect(out).toContain("manual, cron");
    expect(out).toContain("API_KEY");
  });

  it("passes but emits an advisory determinism warning for bare nondeterminism", async () => {
    const file = join(dir, "racy.ts");
    writeFileSync(
      file,
      `export const meta = { slug: "racy", triggers: [{ kind: "manual" }] };
       const now = Date.now();
       console.log(now);`,
    );
    const lines: string[] = [];
    await runCheck({ file }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain('"racy" is valid'); // advisory — does not fail the check
    expect(out).toContain("determinism warning");
    expect(out).toContain("Date.now");
  });

  it("emits NO determinism warning when nondeterminism is inside step.run", async () => {
    const file = join(dir, "clean.ts");
    writeFileSync(
      file,
      `import { step } from "@boardwalk-labs/workflow";
       export const meta = { slug: "clean", triggers: [{ kind: "manual" }] };
       const now = await step.run("stamp", () => Date.now());
       console.log(now);`,
    );
    const lines: string[] = [];
    await runCheck({ file }, { log: (l) => lines.push(l) });
    expect(lines.join("\n")).not.toContain("determinism warning");
  });

  it("fails a program with no meta", async () => {
    const file = join(dir, "bad.ts");
    writeFileSync(file, `export const notMeta = 1;`);
    await expect(runCheck({ file }, { log: () => undefined })).rejects.toThrow(/No `meta`/);
  });

  it("fails a manifest-schema violation (missing triggers)", async () => {
    const file = join(dir, "no-triggers.ts");
    writeFileSync(file, `export const meta = { slug: "no-triggers" };`);
    await expect(runCheck({ file }, { log: () => undefined })).rejects.toThrow(/triggers/);
  });

  it("fails a program that does not compile (unresolved import)", async () => {
    const file = join(dir, "broken.ts");
    writeFileSync(
      file,
      `import { x } from "./does-not-exist.ts";
       export const meta = { slug: "broken", triggers: [{ kind: "manual" }] };
       console.log(x);`,
    );
    await expect(runCheck({ file }, { log: () => undefined })).rejects.toThrow(/Bundling failed/);
  });
});
