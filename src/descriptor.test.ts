// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDescriptor, resolveProjectRoot, resolveRunEntry } from "./descriptor.js";

const VALID = `{
  // comments are fine — this is JSONC
  "slug": "triage",
  "triggers": [{ "kind": "manual" },],
}`;

describe("resolveProjectRoot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-root-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a directory as-is and the descriptor file's parent", () => {
    writeFileSync(join(dir, "workflow.jsonc"), VALID);
    expect(resolveProjectRoot(dir)).toBe(dir);
    expect(resolveProjectRoot(join(dir, "workflow.jsonc"))).toBe(dir);
  });

  it("rejects a lone program file — the new format has no descriptor-less deploy", () => {
    writeFileSync(join(dir, "index.ts"), "export default async function run() {}");
    expect(() => resolveProjectRoot(join(dir, "index.ts"))).toThrow(/Not a workflow package/);
  });

  it("rejects a missing path", () => {
    expect(() => resolveProjectRoot(join(dir, "ghost"))).toThrow(/not found/);
  });
});

describe("loadDescriptor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-desc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses workflow.jsonc (comments + trailing commas) and keeps the raw text verbatim", () => {
    writeFileSync(join(dir, "workflow.jsonc"), VALID);
    const loaded = loadDescriptor(dir);
    expect(loaded.fileName).toBe("workflow.jsonc");
    expect(loaded.descriptor.slug).toBe("triage");
    expect(loaded.descriptor.triggers).toEqual([{ kind: "manual" }]);
    expect(loaded.raw).toBe(VALID); // shipped verbatim, comments intact
    // Schema defaults applied (the same fully-defaulted contract every engine consumes):
    expect(loaded.descriptor.runs_on).toBe("boardwalk/linux");
    expect(loaded.descriptor.concurrency).toEqual({ mode: "unlimited" });
  });

  it("accepts plain workflow.json too", () => {
    writeFileSync(
      join(dir, "workflow.json"),
      JSON.stringify({ slug: "strict", triggers: [{ kind: "manual" }] }),
    );
    expect(loadDescriptor(dir).fileName).toBe("workflow.json");
  });

  it("errors when BOTH workflow.jsonc and workflow.json exist", () => {
    writeFileSync(join(dir, "workflow.jsonc"), VALID);
    writeFileSync(join(dir, "workflow.json"), `{"slug":"x","triggers":[{"kind":"manual"}]}`);
    expect(() => loadDescriptor(dir)).toThrow(/Both workflow\.jsonc AND workflow\.json/);
  });

  it("errors when neither descriptor exists", () => {
    expect(() => loadDescriptor(dir)).toThrow(/No workflow\.jsonc/);
  });

  it("rejects a schema violation (missing triggers) with the file name in the message", () => {
    writeFileSync(join(dir, "workflow.jsonc"), `{ "slug": "no-triggers" }`);
    expect(() => loadDescriptor(dir)).toThrow(/workflow\.jsonc.*triggers/s);
  });

  it("rejects hand-written input_schema/output_schema — those are DERIVED at deploy", () => {
    writeFileSync(
      join(dir, "workflow.jsonc"),
      `{ "slug": "x", "triggers": [{ "kind": "manual" }], "input_schema": { "type": "object" } }`,
    );
    expect(() => loadDescriptor(dir)).toThrow(/input_schema/);
  });

  it("rejects a bad concurrency.key template (syntax checked at parse)", () => {
    writeFileSync(
      join(dir, "workflow.jsonc"),
      `{ "slug": "x", "triggers": [{ "kind": "manual" }],
         "concurrency": { "mode": "serial", "key": "refund-\${customerId}" } }`,
    );
    expect(() => loadDescriptor(dir)).toThrow(/concurrency|input/i);
  });

  it("rejects malformed JSONC with an actionable error", () => {
    writeFileSync(join(dir, "workflow.jsonc"), `{ "slug": `);
    expect(() => loadDescriptor(dir)).toThrow(/not valid JSON/);
  });
});

describe("resolveRunEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-entry-"));
    writeFileSync(join(dir, "workflow.jsonc"), VALID);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function descriptorWith(entry?: string): ReturnType<typeof loadDescriptor>["descriptor"] {
    if (entry !== undefined) {
      writeFileSync(
        join(dir, "workflow.jsonc"),
        `{ "slug": "triage", "entry": ${JSON.stringify(entry)}, "triggers": [{ "kind": "manual" }] }`,
      );
    }
    return loadDescriptor(dir).descriptor;
  }

  it("defaults to src/index.ts", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default async function run() {}");
    expect(resolveRunEntry(dir, descriptorWith())).toBe(join(dir, "src", "index.ts"));
  });

  it("honors the descriptor's entry", () => {
    writeFileSync(join(dir, "main.ts"), "export default async function run() {}");
    expect(resolveRunEntry(dir, descriptorWith("main.ts"))).toBe(join(dir, "main.ts"));
  });

  it("falls back to main.py (the Python default) when no TS entry exists", () => {
    writeFileSync(join(dir, "main.py"), "async def run(input):\n    return input\n");
    expect(resolveRunEntry(dir, descriptorWith())).toBe(join(dir, "main.py"));
  });

  it("prefers the TS default over main.py when both exist", () => {
    writeFileSync(join(dir, "main.py"), "async def run(input):\n    return input\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default async function run() {}");
    expect(resolveRunEntry(dir, descriptorWith())).toBe(join(dir, "src", "index.ts"));
  });

  it("honors a declared .py entry", () => {
    writeFileSync(join(dir, "app.py"), "async def run(input):\n    return input\n");
    expect(resolveRunEntry(dir, descriptorWith("app.py"))).toBe(join(dir, "app.py"));
  });

  it("errors when the declared entry is missing", () => {
    expect(() => resolveRunEntry(dir, descriptorWith("nope.ts"))).toThrow(/does not exist/);
  });

  it("rejects an entry that escapes the package (the SDK schema refuses `..` segments)", () => {
    // The descriptor schema itself refuses traversal, so this never reaches the filesystem;
    // resolveRunEntry keeps a belt-and-braces containment check behind it.
    expect(() => descriptorWith("../outside.ts")).toThrow(/must not contain|escapes/);
  });

  it("errors with a pointer at src/index.ts when nothing resolves", () => {
    let caught: unknown;
    try {
      resolveRunEntry(dir, descriptorWith());
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: expect.stringContaining("No entry found"),
      hint: expect.stringContaining("src/index.ts"),
    });
  });
});
