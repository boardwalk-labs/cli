// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  computeNudge,
  suggestUpgradeCommand,
  recordServerVersionHeaders,
  seenServerVersion,
  resetSeenServerVersion,
  maybePrintVersionNudge,
} from "./version_nudge.js";

beforeEach(() => {
  resetSeenServerVersion();
});
afterEach(() => {
  resetSeenServerVersion();
});

describe("compareVersions", () => {
  it("orders numerically, not lexically, and strips pre-release/build suffixes", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.1.33", "0.2.0")).toBe(-1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.1+sha", "0.2.0")).toBe(1);
  });
});

describe("computeNudge", () => {
  it("flags below-min over behind", () => {
    expect(computeNudge("0.1.5", { latest: "0.2.1", min: "0.2.0" })).toEqual({
      kind: "below-min",
      current: "0.1.5",
      target: "0.2.0",
    });
  });
  it("flags behind when at/above min but below latest", () => {
    expect(computeNudge("0.2.0", { latest: "0.2.1", min: "0.2.0" })).toEqual({
      kind: "behind",
      current: "0.2.0",
      target: "0.2.1",
    });
  });
  it("is null when up to date, or when the server advertised nothing", () => {
    expect(computeNudge("0.2.1", { latest: "0.2.1", min: "0.2.0" })).toBeNull();
    expect(computeNudge("9.9.9", { latest: "0.2.1", min: "0.2.0" })).toBeNull();
    expect(computeNudge("0.2.0", {})).toBeNull();
  });
});

describe("suggestUpgradeCommand", () => {
  it("picks brew for a Homebrew cellar path, npm otherwise", () => {
    expect(
      suggestUpgradeCommand("file:///opt/homebrew/Cellar/boardwalk/0.2.0/libexec/index.js"),
    ).toBe("brew upgrade boardwalk");
    expect(
      suggestUpgradeCommand("file:///usr/lib/node_modules/@boardwalk-labs/cli/dist/index.js"),
    ).toBe("npm install -g @boardwalk-labs/cli@latest");
  });
});

describe("recordServerVersionHeaders", () => {
  it("captures the two headers, ignores a response that carries neither", () => {
    recordServerVersionHeaders(new Headers({ "x-boardwalk-cli-latest": "0.2.1" }));
    expect(seenServerVersion()).toEqual({ latest: "0.2.1", min: undefined });
    resetSeenServerVersion();
    recordServerVersionHeaders(new Headers({ "content-type": "application/json" }));
    expect(seenServerVersion()).toBeUndefined();
  });
});

describe("maybePrintVersionNudge", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bwk-nudge-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = (lines: string[], now = 1_000_000) => ({
    configDir: dir,
    currentVersion: "0.2.0",
    moduleUrl: "file:///usr/lib/node_modules/@boardwalk-labs/cli/dist/index.js",
    log: (l: string) => lines.push(l),
    now: () => now,
  });

  it("stays silent when the server advertised nothing", () => {
    const lines: string[] = [];
    maybePrintVersionNudge(deps(lines));
    expect(lines).toEqual([]);
  });

  it("prints a 'behind' nudge once, then throttles for 24h", () => {
    recordServerVersionHeaders(
      new Headers({ "x-boardwalk-cli-latest": "0.2.1", "x-boardwalk-cli-min": "0.2.0" }),
    );
    const lines: string[] = [];

    maybePrintVersionNudge(deps(lines, 1_000_000));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0.2.0 → 0.2.1");
    expect(lines[0]).toContain("npm install -g @boardwalk-labs/cli@latest");

    // 1 hour later — throttled.
    maybePrintVersionNudge(deps(lines, 1_000_000 + 60 * 60 * 1000));
    expect(lines).toHaveLength(1);

    // 25 hours later — nudges again.
    maybePrintVersionNudge(deps(lines, 1_000_000 + 25 * 60 * 60 * 1000));
    expect(lines).toHaveLength(2);
  });

  it("warns more strongly when below the minimum supported version", () => {
    recordServerVersionHeaders(
      new Headers({ "x-boardwalk-cli-latest": "0.3.0", "x-boardwalk-cli-min": "0.2.5" }),
    );
    const lines: string[] = [];
    maybePrintVersionNudge(deps(lines));
    expect(lines[0]).toContain("older than the minimum");
    expect(lines[0]).toContain("0.2.5");
  });
});
