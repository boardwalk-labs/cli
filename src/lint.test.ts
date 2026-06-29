// SPDX-License-Identifier: MIT

// Tests the CLI's gate behavior (count / throw / --allow-nondeterminism), NOT the SDK lint's message
// wording — that is owned and tested in @boardwalk-labs/workflow and varies by installed version.

import { describe, it, expect } from "vitest";
import { reportDeterminism, enforceDeterminism } from "./lint.js";
import { CliError } from "./errors.js";

const CLEAN = `import { now, output } from "@boardwalk-labs/workflow";
output(await now());`;

const RACY = `const a = Date.now();
const b = Math.random();`;

// Bare fetch is flagged by the lint but is ADVISORY — it must not block deploy (the simple-script case).
const FETCH_ONLY = `const r = await fetch("https://example.com");`;

describe("reportDeterminism", () => {
  it("returns 0 and prints nothing for a clean program", () => {
    const lines: string[] = [];
    expect(reportDeterminism(CLEAN, "index.ts", (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });

  it("returns the count and prints each warning with its location", () => {
    const lines: string[] = [];
    expect(reportDeterminism(RACY, "index.ts", (l) => lines.push(l))).toBe(2);
    const out = lines.join("\n");
    expect(out).toContain("2 determinism warnings");
    expect(out).toContain("index.ts:1:11"); // Date.now() position
    expect(out).toContain("Date.now");
    expect(out).toContain("Math.random");
  });
});

describe("enforceDeterminism", () => {
  it("is a no-op on a clean program", () => {
    const lines: string[] = [];
    expect(() => enforceDeterminism(CLEAN, "index.ts", (l) => lines.push(l), false)).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("throws a CliError with a fix hint when warnings remain", () => {
    const lines: string[] = [];
    try {
      enforceDeterminism(RACY, "index.ts", (l) => lines.push(l), false);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      const e = err as CliError;
      expect(e.message).toMatch(/2 determinism issues/);
      expect(e.hint).toContain("--allow-nondeterminism");
    }
    expect(lines.join("\n")).toContain("Date.now"); // warnings printed before the throw
  });

  it("proceeds (no throw) with a note when allow is set", () => {
    const lines: string[] = [];
    expect(() => enforceDeterminism(RACY, "index.ts", (l) => lines.push(l), true)).not.toThrow();
    expect(lines.join("\n")).toContain("proceeding anyway (--allow-nondeterminism)");
  });

  it("prints but does NOT block on advisory-only warnings (bare fetch)", () => {
    const lines: string[] = [];
    expect(() =>
      enforceDeterminism(FETCH_ONLY, "index.ts", (l) => lines.push(l), false),
    ).not.toThrow();
    const out = lines.join("\n");
    expect(out).toContain("fetch"); // still surfaced
    expect(out).not.toContain("proceeding anyway"); // nothing to override — it just deploys
  });
});
