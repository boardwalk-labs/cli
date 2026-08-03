// SPDX-License-Identifier: MIT

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { typecheckPackage, type TscRunner } from "./typecheck.js";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bw-typecheck-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A package dir where `typescript` resolves (a stub package with the tsc entry present). */
function packageWithTypescript(): string {
  const dir = scratch();
  writeFileSync(join(dir, "package.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const tsDir = join(dir, "node_modules", "typescript", "lib");
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "typescript", "package.json"),
    JSON.stringify({ name: "typescript", version: "5.0.0", main: "lib/typescript.js" }),
  );
  writeFileSync(join(tsDir, "typescript.js"), "");
  writeFileSync(join(tsDir, "tsc.js"), "");
  return dir;
}

describe("typecheckPackage", () => {
  it("skips with a note when the package has no tsconfig", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "{}");
    const outcome = typecheckPackage(dir);
    expect(outcome.ran).toBe(false);
    expect(outcome.note).toContain("no tsconfig.json");
  });

  it("skips with an install hint when `typescript` is not resolvable — never a hard block", () => {
    const dir = scratch();
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    const outcome = typecheckPackage(dir);
    expect(outcome.ran).toBe(false);
    expect(outcome.note).toContain("devDependencies");
  });

  it("runs tsc from the package dir and reports success", () => {
    const dir = packageWithTypescript();
    const invocations: { tscPath: string; args: string[]; cwd: string }[] = [];
    const runner: TscRunner = (tscPath, args, cwd) => {
      invocations.push({ tscPath, args, cwd });
      return { status: 0, stdout: "", stderr: "" };
    };
    const outcome = typecheckPackage(dir, runner);
    expect(outcome.ran).toBe(true);
    expect(invocations[0]?.tscPath).toContain(join("typescript", "lib", "tsc.js"));
    expect(invocations[0]?.args).toContain("--noEmit");
    expect(invocations[0]?.cwd).toBe(dir);
  });

  it("fails with tsc's diagnostics in the hint when the package has type errors", () => {
    const dir = packageWithTypescript();
    const runner: TscRunner = () => ({
      status: 2,
      stdout: "src/index.ts(5,17): error TS2353: 'minutes' does not exist in type…",
      stderr: "",
    });
    expect(() => typecheckPackage(dir, runner)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("type errors"),
        hint: expect.stringContaining("TS2353"),
      }) as Error,
    );
  });
});
