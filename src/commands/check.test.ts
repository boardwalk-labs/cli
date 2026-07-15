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

  it("passes bare Date.now()/Math.random() — plain TypeScript, no determinism gate", async () => {
    // The snapshot substrate made the whole heap durable, so the determinism lint is deleted:
    // authors write ordinary TypeScript and a suspended run resumes with its exact state.
    const file = join(dir, "plain.ts");
    writeFileSync(
      file,
      `export const meta = { slug: "plain", triggers: [{ kind: "manual" }] };
       const now = Date.now();
       const r = Math.random();
       console.log(now, r);`,
    );
    const lines: string[] = [];
    await runCheck({ file }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain('"plain" is valid');
    expect(out).not.toContain("determinism");
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
