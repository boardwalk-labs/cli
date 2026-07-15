// SPDX-License-Identifier: MIT

// CLI staleness nudge. The api-server advertises the published-CLI window on every response
// (`x-boardwalk-cli-latest` / `x-boardwalk-cli-min`); the CLI records what it saw and, at most once
// a day, prints a short, install-method-aware hint to STDERR (never stdout — a nudge must not
// corrupt `run --json` output). We do NOT auto-update: a self-updating binary fights the package
// manager that installed it and makes CI non-reproducible.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveErrLog } from "./log.js";

/** The version window the server last advertised this process. */
export interface ServerVersion {
  latest?: string | undefined;
  min?: string | undefined;
}

// The CLI is a single-shot process, so one module-level record of the server-advertised window is
// safe and avoids threading a callback through every command's client construction.
let seen: ServerVersion | undefined;

/** Record the version headers off any API response (called from the client's request paths). */
export function recordServerVersionHeaders(headers: Headers): void {
  const latest = headers.get("x-boardwalk-cli-latest") ?? undefined;
  const min = headers.get("x-boardwalk-cli-min") ?? undefined;
  if (latest !== undefined || min !== undefined) seen = { latest, min };
}

/** What the server last advertised, or undefined if it advertised nothing (dev / self-host). */
export function seenServerVersion(): ServerVersion | undefined {
  return seen;
}

/** Reset — for tests. */
export function resetSeenServerVersion(): void {
  seen = undefined;
}

/**
 * Compare two dotted versions numerically (`0.2.10` > `0.2.9`). Any pre-release/build suffix
 * (`-rc.1`, `+sha`) is stripped before comparison — the nudge is coarse, not a semver resolver.
 * Returns -1, 0, or 1.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .trim()
      .replace(/[-+].*$/, "")
      .split(".")
      .map((p) => Number.parseInt(p, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface Nudge {
  /** `below-min`: the server may reject this build; `behind`: a newer build exists. */
  kind: "below-min" | "behind";
  current: string;
  target: string;
}

/** Decide whether (and how) to nudge, purely from the versions. `below-min` wins over `behind`. */
export function computeNudge(current: string, server: ServerVersion): Nudge | null {
  if (server.min !== undefined && compareVersions(current, server.min) < 0) {
    return { kind: "below-min", current, target: server.min };
  }
  if (server.latest !== undefined && compareVersions(current, server.latest) < 0) {
    return { kind: "behind", current, target: server.latest };
  }
  return null;
}

/**
 * Best-effort install-method detection → the right upgrade command. `moduleUrl` is `import.meta.url`
 * of the running CLI (its path reveals a Homebrew cellar); the Bun single-file binary is detected
 * via `process.versions.bun`. Everything else is assumed to be an npm global.
 */
export function suggestUpgradeCommand(moduleUrl: string): string {
  if (typeof process.versions.bun === "string") {
    return "download the latest binary from the Boardwalk releases page";
  }
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(moduleUrl)) {
    return "brew upgrade boardwalk";
  }
  return "npm install -g @boardwalk-labs/cli@latest";
}

const NUDGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface NudgeState {
  lastCliNudgeAt?: number;
}

function statePath(configDir: string): string {
  return join(configDir, "state.json");
}

function readState(configDir: string): NudgeState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(configDir), "utf8"));
    if (parsed !== null && typeof parsed === "object" && "lastCliNudgeAt" in parsed) {
      const v: unknown = parsed.lastCliNudgeAt;
      if (typeof v === "number") return { lastCliNudgeAt: v };
    }
  } catch {
    // Missing/corrupt state ⇒ treat as never nudged.
  }
  return {};
}

function writeState(configDir: string, state: NudgeState): void {
  try {
    mkdirSync(dirname(statePath(configDir)), { recursive: true, mode: 0o700 });
    writeFileSync(statePath(configDir), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A non-writable config dir must never break a command — just skip the throttle persist.
  }
}

export interface VersionNudgeDeps {
  configDir: string;
  currentVersion: string;
  moduleUrl: string;
  /** Injected for tests; defaults to process.stderr via resolveErrLog. */
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Print the nudge if the server advertised a window, this build is behind it, and we haven't nudged
 * in the last 24h. Silent otherwise. Emits to STDERR. Call once, at the end of a command.
 */
export function maybePrintVersionNudge(deps: VersionNudgeDeps): void {
  const server = seen;
  if (server === undefined) return; // dev / self-host advertised nothing
  const nudge = computeNudge(deps.currentVersion, server);
  if (nudge === null) return; // up to date

  const now = (deps.now ?? Date.now)();
  const state = readState(deps.configDir);
  if (state.lastCliNudgeAt !== undefined && now - state.lastCliNudgeAt < NUDGE_INTERVAL_MS) {
    return; // nudged recently — stay quiet
  }

  const log = deps.log ?? resolveErrLog({});
  const upgrade = suggestUpgradeCommand(deps.moduleUrl);
  if (nudge.kind === "below-min") {
    log(
      `⚠ Your Boardwalk CLI (${nudge.current}) is older than the minimum the server supports (${nudge.target}). Some commands may fail — update: ${upgrade}`,
    );
  } else {
    log(
      `A newer Boardwalk CLI is available (${nudge.current} → ${nudge.target}). Update: ${upgrade}`,
    );
  }
  writeState(deps.configDir, { lastCliNudgeAt: now });
}
