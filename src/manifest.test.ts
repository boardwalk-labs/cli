// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { extractWorkflowName, extractValidatedManifest } from "./manifest.js";

describe("extractWorkflowName", () => {
  it("extracts a plain string name", () => {
    const src = `export const meta = { name: "nightly-report", description: "d" };`;
    expect(extractWorkflowName(src)).toBe("nightly-report");
  });

  it("unwraps `satisfies WorkflowMeta`", () => {
    const src = `
      import type { WorkflowMeta } from "@boardwalk-labs/workflow";
      export const meta = { name: "wf", description: "d" } satisfies WorkflowMeta;
    `;
    expect(extractWorkflowName(src)).toBe("wf");
  });

  it("reads a no-substitution template literal name", () => {
    const src = 'export const meta = { name: `templated`, description: "d" };';
    expect(extractWorkflowName(src)).toBe("templated");
  });

  it("finds name regardless of property order", () => {
    const src = `export const meta = { description: "d", triggers: [], name: "later" };`;
    expect(extractWorkflowName(src)).toBe("later");
  });

  it("throws when there is no meta declaration", () => {
    expect(() => extractWorkflowName(`export const x = 1;`)).toThrow(/No `meta` declaration/);
  });

  it("throws when meta is not an object literal", () => {
    expect(() => extractWorkflowName(`export const meta = makeMeta();`)).toThrow(/object literal/);
  });

  it("throws when name is missing", () => {
    expect(() => extractWorkflowName(`export const meta = { description: "d" };`)).toThrow(
      /missing or empty/,
    );
  });

  it("throws when name is empty", () => {
    expect(() => extractWorkflowName(`export const meta = { name: "  " };`)).toThrow(
      /missing or empty/,
    );
  });

  it("throws when name is not a pure literal (an interpolated template)", () => {
    const src = "export const meta = { name: `wf-${1}` };";
    expect(() => extractWorkflowName(src)).toThrow(/interpolation|pure literal/);
  });
});

describe("extractValidatedManifest", () => {
  it("returns the fully-defaulted manifest for a valid meta", () => {
    const src = `
      export const meta = {
        name: "ok-wf",
        description: "d",
        triggers: [{ kind: "manual" }],
        secrets: [{ name: "API_KEY" }],
      };
    `;
    const manifest = extractValidatedManifest(src);
    expect(manifest.name).toBe("ok-wf");
    expect(manifest.triggers).toEqual([{ kind: "manual" }]);
    expect(manifest.secrets).toEqual([{ name: "API_KEY" }]);
    // Schema defaults applied:
    expect(manifest.runs_on).toBe("boardwalk/linux");
    expect(manifest.concurrency).toEqual({ mode: "unlimited" });
  });

  it("rejects a meta that fails the schema (no triggers)", () => {
    const src = `export const meta = { name: "no-triggers" };`;
    expect(() => extractValidatedManifest(src)).toThrow(/triggers/);
  });

  it("rejects unknown fields", () => {
    const src = `
      export const meta = { name: "x", triggers: [{ kind: "manual" }], instructions: "nope" };
    `;
    expect(() => extractValidatedManifest(src)).toThrow(/instructions/);
  });

  it("rejects a non-pure-literal meta with the extraction hint", () => {
    const src = `export const meta = { name: "x", triggers: [{ kind: "manual" }], ...extra };`;
    expect(() => extractValidatedManifest(src)).toThrow(/spread/);
  });
});
