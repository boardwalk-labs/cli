// SPDX-License-Identifier: MIT

// `boardwalk usage [--org <slug>] [--days <n>]` — the org's runs, compute, tokens, credit, autonomy,
// and cache-hit rate over a window, plus the heaviest models + workflows. Read-only (GET /usage).
//
// Org precedence: --org > the linked project's org (.boardwalk/project.json). Auth precedence matches
// the other network commands: --token > BOARDWALK_API_KEY env > stored login.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken } from "../auth/resolve.js";
import { BoardwalkClient, type UsageSummary, type UsageLine } from "../client.js";
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
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });

  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  const days = parseDays(opts.days);

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const token = await resolveToken({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl: deps.config.apiBaseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const usage = await client.getUsage(org, days);
  if (opts.json === true) {
    log(JSON.stringify(usage, null, 2));
    return;
  }
  for (const line of formatUsage(org, usage)) log(line);
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
