// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { planLabel } from "./plan_label.js";

describe("planLabel", () => {
  it("maps every known tier to its display name (matching the web)", () => {
    expect(planLabel("free")).toBe("Free");
    expect(planLabel("solo")).toBe("Solo");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team")).toBe("Team");
    expect(planLabel("enterprise")).toBe("Enterprise");
    expect(planLabel("legacy")).toBe("Grandfathered");
  });

  it("returns null for an absent or unrecognized plan (so callers omit the tier)", () => {
    expect(planLabel(null)).toBeNull();
    expect(planLabel(undefined)).toBeNull();
    expect(planLabel("")).toBeNull();
    expect(planLabel("mystery")).toBeNull();
  });
});
