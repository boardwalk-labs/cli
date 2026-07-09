// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from "vitest";
import { assertNodeRuntime, isBunRuntime } from "./runtime_guard.js";
import { CliError } from "./errors.js";

// Simulate running under Bun by setting the global the guard reads; the tests run on Node, where it
// is otherwise undefined.
function setBun(present: boolean): void {
  const g = globalThis as { Bun?: unknown };
  if (present) g.Bun = { build: () => Promise.resolve({}) };
  else delete g.Bun;
}

describe("runtime_guard", () => {
  afterEach(() => {
    setBun(false);
  });

  it("reports the Node runtime by default (no Bun global)", () => {
    expect(isBunRuntime()).toBe(false);
    expect(() => {
      assertNodeRuntime("dev");
    }).not.toThrow();
  });

  it("detects Bun and blocks local-engine commands with a pointer to the Node build", () => {
    setBun(true);
    expect(isBunRuntime()).toBe(true);
    expect(() => {
      assertNodeRuntime("dev");
    }).toThrow(CliError);
    expect(() => {
      assertNodeRuntime("runner start");
    }).toThrow(/needs the Node build|npm i -g @boardwalk-labs\/cli/);
  });
});
