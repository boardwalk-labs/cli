// SPDX-License-Identifier: MIT

/**
 * Narrow an `unknown` to an indexable record. Replaces the `x as Record<string, unknown>` shortcut
 * at the disk/network parse boundaries (the session file, the project link, API + OAuth responses,
 * the template registry, package.json) — owner directive: predicates over casts. `null` and arrays
 * are not records, so a caller can read fields directly (each still `unknown`) after this guard.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
