// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  HARNESSES,
  harnessById,
  detectHarnesses,
  isHarnessPresent,
  type DetectDeps,
} from "./harness.js";

/** A DetectDeps where a set of bins are "on PATH" and a predicate decides which dirs exist. */
function deps(opts: {
  bins?: string[];
  dirExists?: (p: string) => boolean;
  home?: string;
}): DetectDeps {
  const bins = new Set(opts.bins ?? []);
  return {
    commandExists: (bin) => Promise.resolve(bins.has(bin)),
    dirExists: opts.dirExists ?? (() => false),
    homeDir: opts.home ?? "/home/u",
  };
}

describe("harness table", () => {
  it("has unique ids and at least one detection signal each", () => {
    const ids = HARNESSES.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of HARNESSES) {
      expect(h.bins.length + h.dirs.length).toBeGreaterThan(0);
    }
  });

  it("gives every automated harness at least one run step", () => {
    for (const h of HARNESSES) {
      if (h.automated) expect(h.steps.some((s) => s.kind === "run")).toBe(true);
    }
  });

  it("harnessById resolves known ids and rejects unknown", () => {
    expect(harnessById("claude-code")?.label).toBe("Claude Code");
    expect(harnessById("nope")).toBeUndefined();
  });
});

describe("detection", () => {
  it("detects by PATH binary", async () => {
    expect(await isHarnessPresent(harnessById("claude-code")!, deps({ bins: ["claude"] }))).toBe(
      true,
    );
    expect(await isHarnessPresent(harnessById("claude-code")!, deps({ bins: [] }))).toBe(false);
  });

  it("detects by home config dir", async () => {
    const d = deps({ dirExists: (p) => p === "/home/u/.config/opencode", home: "/home/u" });
    expect(await isHarnessPresent(harnessById("opencode")!, d)).toBe(true);
  });

  it("returns present harnesses in table order", async () => {
    const d = deps({
      bins: ["claude"],
      dirExists: (p) => p.endsWith(".config/opencode"),
    });
    const found = (await detectHarnesses(d)).map((h) => h.id);
    expect(found).toEqual(["claude-code", "opencode"]);
  });

  it("detects nothing when no signal matches", async () => {
    expect((await detectHarnesses(deps({}))).length).toBe(0);
  });
});
