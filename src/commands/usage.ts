// SPDX-License-Identifier: MIT

// `boardwalk usage [--org <slug>] [--days <n>]` — the org's runs, compute, tokens, credit, autonomy,
// and cache-hit rate over a window, plus the heaviest models + workflows. Read-only (GET /usage).
//
// Org precedence: --org > the linked project's org (.boardwalk/project.json). Auth precedence matches
// the other network commands: --token > BOARDWALK_API_KEY env > stored login.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { resolveLog } from "../log.js";
import {
  BoardwalkClient,
  type AllowancesSummary,
  type UsageSummary,
  type UsageLine,
} from "../client.js";
import { readLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface UsageOptions {
  org?: string | undefined;
  days?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface UsageDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
}

export async function runUsage(opts: UsageOptions, deps: UsageDeps): Promise<void> {
  const log = resolveLog(deps);

  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const days = parseDays(opts.days);

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { token, baseUrl } = await resolveApiTarget({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const usage = await client.getUsage(org, days).catch((err: unknown) => {
    // A friendly org-not-found rather than leaking `GET /v1/orgs/<slug>/usage failed (404)`.
    if (err instanceof CliError && err.status === 404) {
      throw new CliError(
        `Org "${org}" not found.`,
        "Check the slug with `boardwalk status` (it lists your orgs).",
      );
    }
    throw err instanceof Error ? err : new CliError(String(err));
  });
  // Plan-allowance gauges (real units + a bar, one reset line). Best-effort: the endpoint
  // is additive, so an older / self-hosted backend (or any error) just omits the block.
  const allowances = await client.getAllowances(org).catch(() => null);
  if (opts.json === true) {
    log(JSON.stringify(allowances === null ? usage : { ...usage, allowances }, null, 2));
    return;
  }
  for (const line of formatAllowances(allowances)) log(line);
  for (const line of formatUsage(org, usage)) log(line);
}

/**
 * Render the plan block: one gauge per allowance in REAL units plus a bar ("14.2 of 25
 * agent-hours"), and a single "Allowances reset <date>" line — never a bare percentage (the
 * decided display). Empty for plans without allowances.
 * Pure — exported for tests.
 */
export function formatAllowances(a: AllowancesSummary | null): string[] {
  if (a?.gauges == null) return [];
  const g = a.gauges;
  const lines: string[] = [
    `Plan · ${a.plan}`,
    "",
    gauge("Agent-hours", g.agentHours.used, g.agentHours.included, (n) => trim1(n)),
    gauge("Token pool", g.tokenPool.usedCents, g.tokenPool.includedCents, usd),
    gauge("Searches", g.searches.used, g.searches.included, (n) =>
      Math.round(n).toLocaleString("en-US"),
    ),
  ];
  if (a.spendCap.capCents !== null) {
    lines.push(gauge("Spend cap", a.spendCap.usedCents, a.spendCap.capCents, usd));
  }
  if (a.periodEnd !== null) {
    const reset = new Date(a.periodEnd).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
    lines.push("", `  Allowances reset ${reset}`);
  }
  lines.push("");
  return lines;
}

/** "  Agent-hours  [████████░░░░░░░░░░░░]  14.2 of 25" — a 20-cell bar plus the real units. */
function gauge(label: string, used: number, included: number, fmt: (n: number) => string): string {
  const ratio = included <= 0 ? 0 : Math.min(1, Math.max(0, used / included));
  const filled = Math.round(ratio * 20);
  const bar = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}]`;
  return `  ${label.padEnd(11)} ${bar}  ${fmt(used)} of ${fmt(included)}`;
}

/** One decimal only when it matters: 14.2 stays 14.2, 25 stays 25. */
function trim1(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(1);
}

/** Parse + validate the `--days` window (a positive whole number), or undefined for the server default. */
function parseDays(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliError(
      `Invalid --days "${value}".`,
      "Use a positive whole number of days, e.g. --days 30.",
    );
  }
  return n;
}

/** Render the usage summary as aligned plain-text lines (pure — exported for tests). */
export function formatUsage(org: string, u: UsageSummary): string[] {
  const totalTokens = u.totals.tokensIn + u.totals.tokensOut;
  const minutes = Math.round(u.totals.runtimeSeconds / 60);
  const autoTotal = u.autonomy.humanRuns + u.autonomy.automatedRuns;
  const autoPct = autoTotal === 0 ? 0 : Math.round((u.autonomy.automatedRuns / autoTotal) * 100);
  const cachePct = Math.round(u.cache.hitRate * 100);

  const lines: string[] = [
    `Usage · ${org} · last ${String(u.rangeDays)} days`,
    "",
    row("Runs", u.totals.runs.toLocaleString("en-US")),
    row("Compute", `${minutes.toLocaleString("en-US")} min`),
    row(
      "Tokens",
      `${compact(totalTokens)}  (${compact(u.totals.tokensIn)} in · ${compact(u.totals.tokensOut)} out)`,
    ),
    row("Credit", u.creditCents === null ? "—" : usd(u.creditCents)),
    row("Autonomy", `${String(autoPct)}% automated`),
    row("Cache hit", `${String(cachePct)}%`),
  ];

  appendBreakdown(lines, "Top models", u.byModel);
  appendBreakdown(lines, "Top workflows (by tokens)", u.byWorkflow);
  return lines;
}

/** Append a "  Heading\n    label   value" block for the top few non-empty rows (skipped if none). */
function appendBreakdown(lines: string[], heading: string, items: UsageLine[]): void {
  const top = items.filter((i) => i.tokens > 0).slice(0, 5);
  if (top.length === 0) return;
  lines.push("", `  ${heading}`);
  for (const i of top) lines.push(`    ${i.label.padEnd(34)} ${compact(i.tokens)}`);
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(11)} ${value}`;
}

/** 18432 → "18.4K", 1_840_000 → "1.8M". Mirrors the web dashboard's compact format. */
function compact(n: number): string {
  if (Math.abs(n) < 1_000) return n.toLocaleString("en-US");
  if (Math.abs(n) < 1_000_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Math.abs(n) < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
