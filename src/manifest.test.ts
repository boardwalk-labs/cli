// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { extractWorkflowSlug, extractValidatedManifest } from "./manifest.js";

describe("extractWorkflowSlug", () => {
  it("extracts a plain string name", () => {
    const src = `export const meta = { slug: "nightly-report", description: "d" };`;
    expect(extractWorkflowSlug(src)).toBe("nightly-report");
  });

  it("unwraps `satisfies WorkflowMeta`", () => {
    const src = `
      import type { WorkflowMeta } from "@boardwalk-labs/workflow";
      export const meta = { slug: "wf", description: "d" } satisfies WorkflowMeta;
    `;
    expect(extractWorkflowSlug(src)).toBe("wf");
  });

  it("reads a no-substitution template literal name", () => {
    const src = 'export const meta = { slug: `templated`, description: "d" };';
    expect(extractWorkflowSlug(src)).toBe("templated");
  });

  it("finds name regardless of property order", () => {
    const src = `export const meta = { description: "d", triggers: [], slug: "later" };`;
    expect(extractWorkflowSlug(src)).toBe("later");
  });

  it("throws when there is no meta declaration", () => {
    expect(() => extractWorkflowSlug(`export const x = 1;`)).toThrow(/No `meta` declaration/);
  });

  it("throws when meta is not an object literal", () => {
    expect(() => extractWorkflowSlug(`export const meta = makeMeta();`)).toThrow(/object literal/);
  });

  it("throws when name is missing", () => {
    expect(() => extractWorkflowSlug(`export const meta = { description: "d" };`)).toThrow(
      /missing or empty/,
    );
  });

  it("throws when name is empty", () => {
    expect(() => extractWorkflowSlug(`export const meta = { slug: "  " };`)).toThrow(
      /missing or empty/,
    );
  });

  it("throws when name is not a pure literal (an interpolated template)", () => {
    const src = "export const meta = { slug: `wf-${1}` };";
    expect(() => extractWorkflowSlug(src)).toThrow(/interpolation|pure literal/);
  });
});

describe("extractValidatedManifest", () => {
  it("returns the fully-defaulted manifest for a valid meta", () => {
    const src = `
      export const meta = {
        slug: "ok-wf",
        description: "d",
        triggers: [{ kind: "manual" }],
        permissions: { secrets: [{ name: "API_KEY" }] },
      };
    `;
    const manifest = extractValidatedManifest(src);
    expect(manifest.slug).toBe("ok-wf");
    expect(manifest.triggers).toEqual([{ kind: "manual" }]);
    expect(manifest.permissions?.secrets).toEqual([{ name: "API_KEY" }]);
    // Schema defaults applied:
    expect(manifest.runs_on).toBe("boardwalk/linux");
    expect(manifest.concurrency).toEqual({ mode: "unlimited" });
  });

  it("rejects a meta that fails the schema (no triggers)", () => {
    const src = `export const meta = { slug: "no-triggers" };`;
    expect(() => extractValidatedManifest(src)).toThrow(/triggers/);
  });

  it("rejects unknown fields", () => {
    const src = `
      export const meta = { slug: "x", triggers: [{ kind: "manual" }], instructions: "nope" };
    `;
    expect(() => extractValidatedManifest(src)).toThrow(/instructions/);
  });

  it("rejects a non-pure-literal meta with the extraction hint", () => {
    const src = `export const meta = { slug: "x", triggers: [{ kind: "manual" }], ...extra };`;
    expect(() => extractValidatedManifest(src)).toThrow(/spread/);
  });
});
