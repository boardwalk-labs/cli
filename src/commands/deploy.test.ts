// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { logDeployWarnings, makeCreateConfirmer } from "./deploy.js";
import type { Prompter } from "../prompt.js";

function prompterAnswering(answer: boolean): {
  prompter: Prompter;
  confirm: ReturnType<typeof vi.fn>;
} {
  const confirm = vi.fn(() => Promise.resolve(answer));
  const prompter: Prompter = {
    confirm,
    select: () => Promise.reject(new Error("unused")),
    multiselect: () => Promise.reject(new Error("unused")),
  };
  return { prompter, confirm };
}

describe("makeCreateConfirmer", () => {
  it("--yes skips the gate entirely (undefined — deployWithLink never asks)", () => {
    expect(makeCreateConfirmer({ yes: true, interactive: true })).toBeUndefined();
  });

  it("asks the prompter interactively, naming the slug + org", async () => {
    const { prompter, confirm } = prompterAnswering(true);
    const gate = makeCreateConfirmer({ yes: false, interactive: true, prompter });
    expect(gate).toBeDefined();
    await expect(gate?.({ slug: "triage", orgSlug: "acme" })).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledWith('Create new workflow "triage" in org "acme"?');
  });

  it("propagates a decline", async () => {
    const { prompter } = prompterAnswering(false);
    const gate = makeCreateConfirmer({ yes: false, interactive: true, prompter });
    await expect(gate?.({ slug: "triage", orgSlug: "acme" })).resolves.toBe(false);
  });

  it("HARD-ERRORS instead of hanging when there is no TTY and no --yes (CI)", async () => {
    const gate = makeCreateConfirmer({ yes: false, interactive: false });
    let caught: unknown;
    try {
      await gate?.({ slug: "triage", orgSlug: "acme" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: expect.stringContaining("CREATE"),
      hint: expect.stringContaining("--yes"),
    });
  });
});

describe("logDeployWarnings", () => {
  it("prints nothing when the server returned no warnings", () => {
    const lines: string[] = [];
    logDeployWarnings((l) => lines.push(l), []);
    expect(lines).toEqual([]);
  });

  it("prints a header + one bullet per derivation warning", () => {
    const lines: string[] = [];
    logDeployWarnings(
      (l) => lines.push(l),
      ["input field `when` degraded to raw JSON", "output field `blob` degraded to raw JSON"],
    );
    expect(lines).toEqual([
      "⚠ derivation warnings:",
      "  - input field `when` degraded to raw JSON",
      "  - output field `blob` degraded to raw JSON",
    ]);
  });
});
