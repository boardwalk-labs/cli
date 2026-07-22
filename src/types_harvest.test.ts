// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvestTypes, stripJsonComments, tsconfigChain } from "./types_harvest.js";

/** Write `content` at `root/relPath` (POSIX segments), creating parent dirs. */
function put(root: string, relPath: string, content: string): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("harvestTypes — selection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-harvest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps .d.ts/.d.mts/.d.cts + package.json under node_modules; drops everything else", () => {
    put(dir, "node_modules/foo/package.json", `{"name":"foo","types":"index.d.ts"}`);
    put(dir, "node_modules/foo/index.d.ts", "export declare const x: number;");
    put(dir, "node_modules/foo/esm.d.mts", "export declare const m: number;");
    put(dir, "node_modules/foo/cjs.d.cts", "export declare const c: number;");
    put(dir, "node_modules/foo/index.js", "module.exports = 1;");
    put(dir, "node_modules/foo/index.d.ts.map", `{"version":3}`); // sourcemap, not a declaration
    put(dir, "node_modules/foo/README.md", "# foo");
    put(dir, "node_modules/@scope/bar/package.json", `{"name":"@scope/bar"}`);
    put(dir, "node_modules/@scope/bar/dist/types.d.ts", "export declare const y: string;");
    put(dir, "node_modules/.bin/foo", "#!/bin/sh\n"); // executable shims — never harvested

    const { files } = harvestTypes(dir);
    expect(files.map((f) => f.relPath)).toEqual([
      "node_modules/@scope/bar/dist/types.d.ts",
      "node_modules/@scope/bar/package.json",
      "node_modules/foo/cjs.d.cts",
      "node_modules/foo/esm.d.mts",
      "node_modules/foo/index.d.ts",
      "node_modules/foo/package.json",
    ]);
  });

  it("keeps NESTED node_modules copies (dedupe is a later optimization, correctness first)", () => {
    put(dir, "node_modules/a/package.json", `{"name":"a"}`);
    put(dir, "node_modules/a/index.d.ts", "export declare const a1: 1;");
    put(dir, "node_modules/a/node_modules/b/package.json", `{"name":"b"}`);
    put(dir, "node_modules/a/node_modules/b/index.d.ts", "export declare const b2: 2;");

    const { files } = harvestTypes(dir);
    expect(files.map((f) => f.relPath)).toContain("node_modules/a/node_modules/b/index.d.ts");
    expect(files.map((f) => f.relPath)).toContain("node_modules/a/node_modules/b/package.json");
  });

  it("includes the project root package.json (type/imports resolution) and tsconfig.json", () => {
    put(dir, "package.json", `{"name":"proj","type":"module"}`);
    put(dir, "tsconfig.json", `{"compilerOptions":{"strict":true}}`);
    put(dir, "node_modules/foo/package.json", `{"name":"foo"}`);

    const { files } = harvestTypes(dir);
    expect(files.map((f) => f.relPath)).toEqual([
      "node_modules/foo/package.json",
      "package.json",
      "tsconfig.json",
    ]);
  });

  it("a project with no node_modules harvests just tsconfig/package.json — valid, not an error", () => {
    put(dir, "tsconfig.json", `{}`);
    const { files, totalBytes } = harvestTypes(dir);
    expect(files.map((f) => f.relPath)).toEqual(["tsconfig.json"]);
    expect(totalBytes).toBe(2);
  });

  it("a bare directory yields an empty harvest", () => {
    expect(harvestTypes(dir)).toEqual({ files: [], totalBytes: 0 });
  });

  it("totalBytes is the sum of the harvested file sizes", () => {
    put(dir, "node_modules/foo/package.json", `{"name":"foo"}`); // 14 bytes
    put(dir, "node_modules/foo/index.d.ts", "export {};\n"); // 11 bytes
    expect(harvestTypes(dir).totalBytes).toBe(25);
  });
});

describe("harvestTypes — determinism", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-harvest-det-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is sorted by relPath and stable across calls", () => {
    // Create in deliberately unsorted order.
    put(dir, "node_modules/zeta/package.json", `{"name":"zeta"}`);
    put(dir, "node_modules/zeta/z.d.ts", "export {};");
    put(dir, "node_modules/alpha/package.json", `{"name":"alpha"}`);
    put(dir, "node_modules/alpha/a.d.ts", "export {};");
    put(dir, "tsconfig.json", `{}`);

    const first = harvestTypes(dir);
    const second = harvestTypes(dir);
    expect(first).toEqual(second);
    const sorted = [...first.files.map((f) => f.relPath)].sort();
    expect(first.files.map((f) => f.relPath)).toEqual(sorted);
  });
});

describe("harvestTypes — symlink safety", () => {
  let outside: string;
  let dir: string;
  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), "bw-harvest-outside-"));
    dir = mkdtempSync(join(tmpdir(), "bw-harvest-sym-"));
  });
  afterEach(() => {
    rmSync(outside, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializes an in-root directory symlink at the LINK path (pnpm layout)", () => {
    // pnpm: node_modules/foo -> node_modules/.pnpm/foo@1.0.0/node_modules/foo
    put(dir, "node_modules/.pnpm/foo@1.0.0/node_modules/foo/package.json", `{"name":"foo"}`);
    put(dir, "node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.d.ts", "export {};");
    symlinkSync(
      join(dir, "node_modules", ".pnpm", "foo@1.0.0", "node_modules", "foo"),
      join(dir, "node_modules", "foo"),
    );

    const rels = harvestTypes(dir).files.map((f) => f.relPath);
    // Both views ship: the link path (what the compiler resolves through) and the real tree.
    expect(rels).toContain("node_modules/foo/index.d.ts");
    expect(rels).toContain("node_modules/foo/package.json");
    expect(rels).toContain("node_modules/.pnpm/foo@1.0.0/node_modules/foo/index.d.ts");
  });

  it("SKIPS a symlink whose target escapes the project root", () => {
    put(outside, "evil/package.json", `{"name":"evil"}`);
    put(outside, "evil/index.d.ts", "export declare const stolen: string;");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(outside, "evil"), join(dir, "node_modules", "evil"));

    expect(harvestTypes(dir).files).toEqual([]);
  });

  it("skips an out-of-root FILE symlink too", () => {
    writeFileSync(join(outside, "leak.d.ts"), "export {};");
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    put(dir, "node_modules/pkg/package.json", `{"name":"pkg"}`);
    symlinkSync(join(outside, "leak.d.ts"), join(dir, "node_modules", "pkg", "leak.d.ts"));

    const rels = harvestTypes(dir).files.map((f) => f.relPath);
    expect(rels).toEqual(["node_modules/pkg/package.json"]);
  });

  it("terminates on a directory-symlink cycle", () => {
    put(dir, "node_modules/a/package.json", `{"name":"a"}`);
    // a/self -> a — following it forever would recurse without the walk-stack guard.
    symlinkSync(join(dir, "node_modules", "a"), join(dir, "node_modules", "a", "self"));

    const rels = harvestTypes(dir).files.map((f) => f.relPath);
    expect(rels).toEqual(["node_modules/a/package.json"]);
  });

  it("ignores a broken symlink", () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(join(dir, "node_modules", "nope"), join(dir, "node_modules", "dangling"));
    put(dir, "node_modules/ok/package.json", `{"name":"ok"}`);

    expect(harvestTypes(dir).files.map((f) => f.relPath)).toEqual(["node_modules/ok/package.json"]);
  });
});

describe("harvestTypes — tsconfig extends chain", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-harvest-tsc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("follows a relative extends chain", () => {
    put(dir, "tsconfig.json", `{"extends":"./configs/base.json"}`);
    put(dir, "configs/base.json", `{"extends":"./deeper"}`); // ".json" appended on resolve
    put(dir, "configs/deeper.json", `{"compilerOptions":{"strict":true}}`);

    expect(harvestTypes(dir).files.map((f) => f.relPath)).toEqual([
      "configs/base.json",
      "configs/deeper.json",
      "tsconfig.json",
    ]);
  });

  it("resolves a bare-specifier extends into node_modules (file and package forms)", () => {
    put(dir, "tsconfig.json", `{"extends":["@tsconfig/node24/tsconfig.json","strict-preset"]}`);
    put(dir, "node_modules/@tsconfig/node24/tsconfig.json", `{"compilerOptions":{}}`);
    put(dir, "node_modules/strict-preset/tsconfig.json", `{"compilerOptions":{"strict":true}}`);
    // package.json files under node_modules ride along via the normal walk.
    put(dir, "node_modules/strict-preset/package.json", `{"name":"strict-preset"}`);

    const rels = harvestTypes(dir).files.map((f) => f.relPath);
    expect(rels).toContain("node_modules/@tsconfig/node24/tsconfig.json");
    expect(rels).toContain("node_modules/strict-preset/tsconfig.json");
    expect(rels).toContain("tsconfig.json");
  });

  it("keeps the root config but skips a chain member OUTSIDE the project root", () => {
    const outside = mkdtempSync(join(tmpdir(), "bw-harvest-tsc-out-"));
    try {
      put(outside, "shared.json", `{"compilerOptions":{}}`);
      put(dir, "tsconfig.json", `{"extends":"${join(outside, "shared.json")}"}`);
      expect(harvestTypes(dir).files.map((f) => f.relPath)).toEqual(["tsconfig.json"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("reads JSONC — comments and trailing commas", () => {
    put(
      dir,
      "tsconfig.json",
      `{
        // the base
        "extends": "./base.json", /* array form also works */
      }`,
    );
    put(dir, "base.json", `{"compilerOptions":{"strict":true,}}`);

    expect(harvestTypes(dir).files.map((f) => f.relPath)).toEqual(["base.json", "tsconfig.json"]);
  });

  it("survives an extends cycle and an unparseable config (file still ships)", () => {
    put(dir, "tsconfig.json", `{"extends":"./loop.json"}`);
    put(dir, "loop.json", `{"extends":"./tsconfig.json"}`);
    expect(tsconfigChain(dir).length).toBe(2);

    rmSync(join(dir, "loop.json"));
    put(dir, "loop.json", `not json at all`);
    // The broken config is still harvested (its bytes ship); only chain-following stops.
    expect(harvestTypes(dir).files.map((f) => f.relPath)).toEqual(["loop.json", "tsconfig.json"]);
  });
});

describe("stripJsonComments", () => {
  it("preserves comment markers inside string literals", () => {
    const text = `{"a": "http://x", "b": "/* keep */", "c": "// keep"}`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      a: "http://x",
      b: "/* keep */",
      c: "// keep",
    });
  });

  it("handles escaped quotes in strings", () => {
    const text = `{"a": "say \\"hi\\" // not a comment"}`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: `say "hi" // not a comment` });
  });

  it("strips line + block comments and trailing commas", () => {
    const text = `{
      // line
      "a": 1, /* block */
      "b": [1, 2,],
    }`;
    expect(JSON.parse(stripJsonComments(text))).toEqual({ a: 1, b: [1, 2] });
  });
});
