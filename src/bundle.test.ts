// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleWorkflow, bundleWorkflowWithMap, resolveEntry, isPackageDir } from "./bundle.js";
import { extractWorkflowSlug } from "./manifest.js";
import { CliError } from "./errors.js";

describe("isPackageDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-bundle-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true for a directory, false for a file", () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, "export const meta = { slug: 'x' };");
    expect(isPackageDir(dir)).toBe(true);
    expect(isPackageDir(file)).toBe(false);
  });

  it("is false for a missing path", () => {
    expect(isPackageDir(join(dir, "nope"))).toBe(false);
  });
});

describe("resolveEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-entry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a file path unchanged", () => {
    const file = join(dir, "wf.ts");
    writeFileSync(file, "export const meta = { slug: 'x' };");
    expect(resolveEntry(file)).toBe(file);
  });

  it("resolves index.ts inside a directory", () => {
    writeFileSync(join(dir, "index.ts"), "export const meta = { slug: 'x' };");
    expect(resolveEntry(dir)).toBe(join(dir, "index.ts"));
  });

  it("honors package.json module/main", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ module: "main.ts" }));
    writeFileSync(join(dir, "main.ts"), "export const meta = { slug: 'x' };");
    expect(resolveEntry(dir)).toBe(join(dir, "main.ts"));
  });

  it("throws for a directory with no entry", () => {
    expect(() => resolveEntry(dir)).toThrow(/No entry file/);
  });

  it("throws for a missing path", () => {
    expect(() => resolveEntry(join(dir, "ghost"))).toThrow(/not found/);
  });
});

describe("bundleWorkflow", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-bundlewf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inlines a local dependency and leaves @boardwalk-labs/workflow external", async () => {
    writeFileSync(join(dir, "helper.ts"), `export const GREETING = "from-helper";`);
    const entry = join(dir, "index.ts");
    writeFileSync(
      entry,
      `import { agent } from "@boardwalk-labs/workflow";
       import { GREETING } from "./helper.ts";
       export const meta = { slug: "bundled-wf", description: "d" };
       await agent(GREETING, undefined);`,
    );

    const out = await bundleWorkflow(entry);
    // Local dep is inlined (its value present), SDK import is preserved as an external import.
    expect(out).toContain("from-helper");
    expect(out).toMatch(/from\s*"@boardwalk-labs\/workflow"/);
    expect(out).not.toContain("./helper");
  });

  it("keeps meta statically extractable from the bundle output", async () => {
    const entry = join(dir, "index.ts");
    writeFileSync(
      entry,
      `import { sleep } from "@boardwalk-labs/workflow";
       export const meta = { slug: "still-extractable", description: "d" };
       await sleep(1);`,
    );
    const out = await bundleWorkflow(entry);
    // The backend re-derives the manifest from the uploaded (bundled) source — name must survive.
    expect(extractWorkflowSlug(out, "bundle.js")).toBe("still-extractable");
  });

  it("resolves and bundles a package directory via its entry", async () => {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "index.ts"), `export const meta = { slug: "pkg-wf" };`);
    const out = await bundleWorkflow(resolveEntry(join(dir, "pkg")));
    expect(extractWorkflowSlug(out, "bundle.js")).toBe("pkg-wf");
  });
});

// The Bun-native bundler path (used only inside the compiled single-file executable). Real Bun isn't
// available here, so we inject a fake `Bun.build` and verify the branch's OWN logic — picking the
// entry/sourcemap outputs and appending the fixed sourceMappingURL. (That real Bun output is
// extractable is covered by the release workflow's binary smoke test.)
describe("bundleWorkflow — Bun runtime branch", () => {
  const fakeArtifact = (
    text: string,
    kind: BunBuildArtifact["kind"],
    path: string,
  ): BunBuildArtifact => Object.assign(new Blob([text]), { path, kind });

  let lastConfig: BunBuildConfig | undefined;
  function installFakeBun(output: BunBuildOutput): void {
    (globalThis as { Bun?: unknown }).Bun = {
      build: (config: BunBuildConfig): Promise<BunBuildOutput> => {
        lastConfig = config;
        return Promise.resolve(output);
      },
    };
  }
  afterEach(() => {
    delete (globalThis as { Bun?: unknown }).Bun;
    lastConfig = undefined;
  });

  it("bundleWorkflow takes the Bun path and returns the entry output, SDK external + unminified", async () => {
    installFakeBun({
      success: true,
      outputs: [fakeArtifact("export const meta = {};\n", "entry-point", "index.js")],
      logs: [],
    });
    const out = await bundleWorkflow("/some/index.ts");
    expect(out).toBe("export const meta = {};\n");
    expect(lastConfig?.external).toContain("@boardwalk-labs/workflow");
    expect(lastConfig?.minify).toBe(false); // meta must stay statically extractable
  });

  it("bundleWorkflowWithMap returns the map and appends the fixed sourceMappingURL link", async () => {
    installFakeBun({
      success: true,
      outputs: [
        fakeArtifact("CODE", "entry-point", "index.js"),
        fakeArtifact('{"version":3}', "sourcemap", "index.js.map"),
      ],
      logs: [],
    });
    const { code, map } = await bundleWorkflowWithMap("/some/index.ts");
    expect(map).toBe('{"version":3}');
    expect(code).toBe("CODE\n//# sourceMappingURL=index.mjs.map\n");
    expect(lastConfig?.sourcemap).toBe("external");
  });

  it("surfaces a Bun build failure as a CliError", async () => {
    installFakeBun({ success: false, outputs: [], logs: ["boom"] });
    await expect(bundleWorkflow("/some/index.ts")).rejects.toThrow(CliError);
  });
});
