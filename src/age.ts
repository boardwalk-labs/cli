// SPDX-License-Identifier: MIT

// Coarse "time since" label, shared by every column that renders one.

/** Coarse "time since" label: 45s / 12m / 3h / 5d. Callers append " ago" where the column wants it. */
export function age(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)}h`;
  return `${String(Math.round(h / 24))}d`;
}
