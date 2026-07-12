// SPDX-License-Identifier: MIT

// Display name for a subscription tier — the ONE place the CLI turns the backend's plan enum into
// the label a person reads, so `boardwalk status` and `boardwalk usage` print the SAME tier name the
// web surfaces do ("solo" → "Solo", "legacy" → "Grandfathered"). null for an absent (older backend)
// or unrecognized plan, so a caller can omit the tier rather than print a raw enum.

export function planLabel(plan: string | null | undefined): string | null {
  switch (plan) {
    case "free":
      return "Free";
    case "solo":
      return "Solo";
    case "pro":
      return "Pro";
    case "team":
      return "Team";
    case "enterprise":
      return "Enterprise";
    case "legacy":
      return "Grandfathered";
    default:
      return null;
  }
}
