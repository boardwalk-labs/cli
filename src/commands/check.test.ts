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

  it("FAILS on bare nondeterminism and does not print the valid banner", async () => {
    const file = join(dir, "racy.ts");
    writeFileSync(
      file,
      `export const meta = { slug: "racy", triggers: [{ kind: "manual" }] };
       const now = Date.now();
       console.log(now);`,
    );
    const lines: string[] = [];
    await expect(runCheck({ file }, { log: (l) => lines.push(l) })).rejects.toThrow(
      /determinism issue/,
    );
    const out = lines.join("\n");
    expect(out).toContain("Date.now"); // the warning is still printed
    expect(out).not.toContain('"racy" is valid'); // the gate runs before the banner
  });

  it("passes bare nondeterminism with --allow-nondeterminism, still printing the warning", async () => {
    const file = join(dir, "racy-ok.ts");
    writeFileSync(
      file,
      `export const meta = { slug: "racy-ok", triggers: [{ kind: "manual" }] };
       const now = Date.now();
       console.log(now);`,
    );
    const lines: string[] = [];
    await runCheck({ file, allowNondeterminism: true }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain("Date.now");
    expect(out).toContain("--allow-nondeterminism");
    expect(out).toContain('"racy-ok" is valid');
  });

  it("passes a simple non-suspending workflow with a bare fetch (advisory, not blocking)", async () => {
    const file = join(dir, "fetcher.ts");
    writeFileSync(
      file,
      `export const meta = { slug: "fetcher", triggers: [{ kind: "manual" }] };
       const r = await fetch("https://example.com");
       console.log(r);`,
    );
    const lines: string[] = [];
    await runCheck({ file }, { log: (l) => lines.push(l) });
    const out = lines.join("\n");
    expect(out).toContain("fetch"); // surfaced as advisory
    expect(out).toContain('"fetcher" is valid'); // but check still passes
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
