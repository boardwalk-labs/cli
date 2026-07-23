// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleWorkflowWithMap } from "./bundle.js";
import { CliError } from "./errors.js";

describe("bundleWorkflowWithMap", () => {
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
       export default async function run(): Promise<string> {
         return agent(GREETING);
       }`,
    );

    const { code, map } = await bundleWorkflowWithMap(entry);
    // Local dep is inlined (its value present), SDK import is preserved as an external import.
    expect(code).toContain("from-helper");
    expect(code).toMatch(/from\s*"@boardwalk-labs\/workflow"/);
    expect(code).not.toContain("./helper");
    // The default-export run survives as the module's entry surface.
    expect(code).toContain("run");
    expect(JSON.parse(map)).toMatchObject({ version: 3 });
  });

  it("throws a CliError for an unresolvable import", async () => {
    const entry = join(dir, "index.ts");
    writeFileSync(
      entry,
      `import { x } from "./ghost.js";
       export default async function run() { return x; }`,
    );
    await expect(bundleWorkflowWithMap(entry)).rejects.toThrow(/Bundling failed/);
  });
});

// The Bun-native bundler path (used only inside the compiled single-file executable). Real Bun isn't
// available here, so we inject a fake `Bun.build` and verify the branch's OWN logic — picking the
// entry/sourcemap outputs and appending the fixed sourceMappingURL. (That real Bun output works is
// covered by the release workflow's binary smoke test.)
describe("bundleWorkflowWithMap — Bun runtime branch", () => {
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

  it("returns the map and appends the fixed sourceMappingURL link, SDK external + unminified", async () => {
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
    expect(lastConfig?.external).toContain("@boardwalk-labs/workflow");
    expect(lastConfig?.minify).toBe(false);
  });

  it("surfaces a Bun build failure as a CliError", async () => {
    installFakeBun({ success: false, outputs: [], logs: ["boom"] });
    await expect(bundleWorkflowWithMap("/some/index.ts")).rejects.toThrow(CliError);
  });

  it("errors when Bun yields no sourcemap", async () => {
    installFakeBun({
      success: true,
      outputs: [fakeArtifact("CODE", "entry-point", "index.js")],
      logs: [],
    });
    await expect(bundleWorkflowWithMap("/some/index.ts")).rejects.toThrow(/no sourcemap/);
  });
});
