// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArtifact } from "./artifact.js";
import {
  detectPythonDeps,
  languageOfEntry,
  materializeSitePackages,
  parsePyprojectDependencies,
  parseRequirementSpecs,
  PY_TARGET_PLATFORM,
  PY_TARGET_VERSION,
  type UvRunner,
} from "./python.js";

describe("languageOfEntry", () => {
  it("routes .py to python and everything else to typescript", () => {
    expect(languageOfEntry("/pkg/main.py")).toBe("python");
    expect(languageOfEntry("/pkg/src/Main.PY")).toBe("python");
    expect(languageOfEntry("/pkg/src/index.ts")).toBe("typescript");
    expect(languageOfEntry("/pkg/index.mjs")).toBe("typescript");
    // A near-miss never routes to python — `.py` is the exact contract.
    expect(languageOfEntry("/pkg/main.pyx")).toBe("typescript");
  });
});

describe("parsePyprojectDependencies", () => {
  it("reads a multi-line [project].dependencies array with comments", () => {
    const text = `[build-system]
requires = ["hatchling"]

[project]
name = "demo"
version = "0.0.0"
dependencies = [
  "pydantic>=2",       # models
  # the SDK ships in the runtime:
  # "boardwalk",
  'httpx==0.27.0',
]

[tool.uv]
dev-dependencies = ["pytest"]
`;
    expect(parsePyprojectDependencies(text)).toEqual(["pydantic>=2", "httpx==0.27.0"]);
  });

  it("keeps PEP 508 extras (brackets inside the string are not the array's close)", () => {
    const text = `[project]\ndependencies = ["pydantic[email]>=2"]\n`;
    expect(parsePyprojectDependencies(text)).toEqual(["pydantic[email]>=2"]);
  });

  it("reads a single-line array", () => {
    const text = `[project]\nname = "x"\ndependencies = ["a", "b>=1"]\n`;
    expect(parsePyprojectDependencies(text)).toEqual(["a", "b>=1"]);
  });

  it("returns [] for an empty or absent dependencies key, or no [project] table", () => {
    expect(parsePyprojectDependencies(`[project]\nname = "x"\ndependencies = []\n`)).toEqual([]);
    expect(parsePyprojectDependencies(`[project]\nname = "x"\n`)).toEqual([]);
    expect(parsePyprojectDependencies(`[tool.poetry]\ndependencies = ["a"]\n`)).toEqual([]);
  });

  it("does not read a dependencies key from another table", () => {
    const text = `[project]\nname = "x"\n\n[tool.other]\ndependencies = ["nope"]\n`;
    expect(parsePyprojectDependencies(text)).toEqual([]);
  });
});

describe("parseRequirementSpecs", () => {
  it("keeps requirement lines, drops blanks and comments, folds continuations", () => {
    const text = `# pinned set
requests==2.32.0

pydantic>=2 \\
  --hash=sha256:abc
`;
    expect(parseRequirementSpecs(text)).toEqual([
      "requests==2.32.0",
      "pydantic>=2 --hash=sha256:abc",
    ]);
  });

  it("returns [] for an empty / comment-only file", () => {
    expect(parseRequirementSpecs("")).toEqual([]);
    expect(parseRequirementSpecs("# nothing here\n\n")).toEqual([]);
  });
});

describe("detectPythonDeps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-pydeps-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("null when nothing is declared (no files, empty pyproject, empty requirements)", () => {
    expect(detectPythonDeps(dir)).toBeNull();

    writeFileSync(join(dir, "requirements.txt"), "# nothing\n");
    expect(detectPythonDeps(dir)).toBeNull();

    writeFileSync(join(dir, "pyproject.toml"), `[project]\nname = "x"\ndependencies = []\n`);
    expect(detectPythonDeps(dir)).toBeNull();
  });

  it("prefers pyproject over requirements.txt when both exist", () => {
    writeFileSync(join(dir, "pyproject.toml"), `[project]\nname = "x"\ndependencies = ["a>=1"]\n`);
    writeFileSync(join(dir, "requirements.txt"), "b==2\n");
    expect(detectPythonDeps(dir)).toEqual({ source: "pyproject", specs: ["a>=1"] });
  });

  it("an empty-dep pyproject shadows a requirements.txt (pyproject is the declaration)", () => {
    writeFileSync(join(dir, "pyproject.toml"), `[project]\nname = "x"\n`);
    writeFileSync(join(dir, "requirements.txt"), "b==2\n");
    expect(detectPythonDeps(dir)).toBeNull();
  });

  it("falls back to requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "b==2\n");
    expect(detectPythonDeps(dir)).toEqual({ source: "requirements", specs: ["b==2"] });
  });
});

describe("materializeSitePackages (uv runner seam)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-pymat-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const enoent = (): UvRunner => () => ({
    status: null,
    stderr: "",
    error: Object.assign(new Error("spawn uv ENOENT"), { code: "ENOENT" }),
  });

  it("uv missing → a clear error naming the install command", () => {
    expect(() =>
      materializeSitePackages(dir, { source: "requirements", specs: ["a"] }, enoent()),
    ).toThrow(/needs `uv`/);
    try {
      materializeSitePackages(dir, { source: "requirements", specs: ["a"] }, enoent());
    } catch (err) {
      expect((err as { hint?: string }).hint).toMatch(/astral\.sh\/uv|brew install uv/);
    }
  });

  it("a failed uv command surfaces its stderr as the hint", () => {
    const failing: UvRunner = () => ({ status: 1, stderr: "No solution found: boom" });
    expect(() =>
      materializeSitePackages(dir, { source: "requirements", specs: ["a"] }, failing),
    ).toThrow(/`uv pip install .* failed \(exit 1\)/);
  });

  it("pyproject path: lock → export --frozen → pip install --target, pinned to the runner platform", () => {
    const calls: string[][] = [];
    const fake: UvRunner = (args) => {
      calls.push(args);
      if (args[0] === "pip") {
        // Simulate an install into the temp target.
        const target = args[args.indexOf("--target") + 1] ?? "";
        mkdirSync(join(target, "demo"), { recursive: true });
        writeFileSync(join(target, "demo", "__init__.py"), "x = 1\n");
        // Never-packed noise: bytecode + console-script shims with host-path shebangs.
        mkdirSync(join(target, "demo", "__pycache__"), { recursive: true });
        writeFileSync(join(target, "demo", "__pycache__", "__init__.cpython-313.pyc"), "junk");
        mkdirSync(join(target, "bin"), { recursive: true });
        writeFileSync(join(target, "bin", "demo-cli"), "#!/tmp/python\n");
      }
      return { status: 0, stderr: "" };
    };

    const site = materializeSitePackages(dir, { source: "pyproject", specs: ["demo"] }, fake);
    try {
      expect(calls.map((c) => c[0])).toEqual(["lock", "export", "pip"]);
      expect(calls[1]).toContain("--frozen");
      expect(calls[1]).toContain("--no-emit-project");
      const pip = calls[2] ?? [];
      expect(pip).toContain("--python-version");
      expect(pip).toContain(PY_TARGET_VERSION);
      expect(pip).toContain("--python-platform");
      expect(pip).toContain(PY_TARGET_PLATFORM);
      expect(pip).toContain("--no-compile-bytecode");

      expect(site.files.map((f) => f.relPath)).toEqual(["demo/__init__.py"]);
      expect(site.totalBytes).toBeGreaterThan(0);
    } finally {
      site.cleanup();
    }
  });

  it("requirements path: a single resolve+install against the project's requirements.txt", () => {
    writeFileSync(join(dir, "requirements.txt"), "demo==1\n");
    const calls: string[][] = [];
    const fake: UvRunner = (args) => {
      calls.push(args);
      return { status: 0, stderr: "" };
    };
    const site = materializeSitePackages(dir, { source: "requirements", specs: ["demo==1"] }, fake);
    try {
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toBe("pip");
      expect(calls[0]).toContain(join(dir, "requirements.txt"));
      expect(site.files).toEqual([]); // fake installed nothing — empty is a valid layer
    } finally {
      site.cleanup();
    }
  });
});

// ── Real uv end-to-end (skipped cleanly when uv is not installed) ─────────────────────────

const hasUv = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasUv)("materialize with the real uv (network)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-pyuv-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "resolves + freezes a tiny pure-python dep through the full build",
    { timeout: 120_000 },
    async () => {
      writeFileSync(
        join(dir, "workflow.jsonc"),
        `{ "slug": "py-e2e", "triggers": [{ "kind": "manual" }] }`,
      );
      writeFileSync(join(dir, "main.py"), "async def run(input):\n    return input\n");
      writeFileSync(
        join(dir, "pyproject.toml"),
        `[project]\nname = "py-e2e"\nversion = "0.0.0"\nrequires-python = ">=3.13"\ndependencies = ["six==1.17.0"]\n`,
      );

      const art = await buildArtifact(dir);
      expect(art.language).toBe("python");
      // The frozen layer: six's module + its dist-info metadata, under the ratified prefix.
      expect(art.machinePaths).toContain(".bw-machine/site-packages/six.py");
      expect(art.machinePaths.some((p) => p.includes("six-1.17.0.dist-info"))).toBe(true);
      // No bytecode was shipped (byte-compiling is an open cold-start benchmark).
      expect(art.machinePaths.every((p) => !p.endsWith(".pyc"))).toBe(true);
      // `uv lock` wrote the project lockfile; it anchors the build and ships with the sources.
      expect(existsSync(join(dir, "uv.lock"))).toBe(true);
      expect(art.lockfileDigest).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
