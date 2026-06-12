import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, workflowNameFor } from "./init.js";
import { extractValidatedManifest } from "../manifest.js";

describe("runInit", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds the hello template with a manifest-valid program", () => {
    const target = join(dir, "my-digest");
    const lines: string[] = [];
    runInit({ dir: target, template: "hello" }, { log: (l) => lines.push(l) });

    for (const f of ["index.ts", "package.json", ".env.example", ".gitignore"]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    // The scaffolded program passes the same validation `check`/`dev` run.
    const manifest = extractValidatedManifest(readFileSync(join(target, "index.ts"), "utf8"));
    expect(manifest.name).toBe("my-digest");
    expect(manifest.triggers).toEqual([{ kind: "manual" }]);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toContain(".env");
    expect(lines.join("\n")).toContain('scaffolded "my-digest"');
  });

  it("refuses to overwrite existing files", () => {
    const target = join(dir, "taken");
    runInit({ dir: target, template: "hello" }, { log: () => undefined });
    expect(() => {
      runInit({ dir: target, template: "hello" }, { log: () => undefined });
    }).toThrow(/already exists/);
  });

  it("aborts before writing anything when one target exists", () => {
    const target = join(dir, "partial");
    runInit({ dir: target, template: "hello" }, { log: () => undefined });
    rmSync(join(target, "package.json"));
    writeFileSync(join(target, ".gitignore"), "mine\n");
    expect(() => {
      runInit({ dir: target, template: "hello" }, { log: () => undefined });
    }).toThrow(/already exists/);
    // Nothing was (re)written: package.json is still gone, .gitignore untouched.
    expect(existsSync(join(target, "package.json"))).toBe(false);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("mine\n");
  });

  it("rejects an unknown template, listing what exists in the hint", () => {
    let caught: unknown;
    try {
      runInit({ dir: join(dir, "x"), template: "nope" }, { log: () => undefined });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: expect.stringContaining("Unknown template"),
      hint: expect.stringContaining("hello"),
    });
  });
});

describe("workflowNameFor", () => {
  it("kebab-cases the directory basename into a legal name", () => {
    expect(workflowNameFor("/tmp/My Cool_Workflow!")).toBe("my-cool-workflow");
  });

  it("falls back when nothing legal survives", () => {
    expect(workflowNameFor("/tmp/算法")).toBe("my-workflow");
  });
});
