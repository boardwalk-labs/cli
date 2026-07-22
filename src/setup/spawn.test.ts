// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { commandExists, type RunCommand } from "./spawn.js";

describe("commandExists", () => {
  it("is true when the probe exits 0", async () => {
    const run: RunCommand = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    expect(await commandExists("claude", run)).toBe(true);
  });

  it("is false when the probe exits non-zero", async () => {
    const run: RunCommand = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
    expect(await commandExists("nope", run)).toBe(false);
  });

  it("probes with which/where for the given binary", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const run: RunCommand = (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    await commandExists("claude", run);
    expect(calls.length).toBe(1);
    expect(["which", "where"]).toContain(calls[0]?.cmd);
    expect(calls[0]?.args).toEqual(["claude"]);
  });
});
