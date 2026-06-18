// SPDX-License-Identifier: MIT

// `boardwalk models` — browse the managed-lane model catalog: what an `agent({ model })` call can run
// on the managed `boardwalk` provider, and what each costs.
//   • models list [--all] [--search <q>]   → a priced table (most-capable first)
//   • models show <id>                       → one model's price + context + whether it's supported
//
// Prices are all-in per-million-token (the managed margin is already applied). The catalog is the SAME
// set the lane routes at run time, so a model's presence here means it's supported. Read-only; the
// underlying endpoint is public, but the command authenticates like every other (stored login / key).

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { ModelListItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

/** How many models `list` shows by default; `--all` or `--search` lifts the cap (the catalog is
 *  featured-first, so the default head is the most capable / commonly-reached set). */
const DEFAULT_LIST_LIMIT = 30;

export interface ModelsListOptions {
  all?: boolean | undefined;
  search?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface ModelsShowOptions {
  id: string;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface ModelsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export async function runModelsList(opts: ModelsListOptions, deps: ModelsDeps): Promise<void> {
  const log = resolveLog(deps);
  const { client } = await resolveOrgClient(deps, { token: opts.token });
  const catalog = await client.listModels();
  const matched = filterModels(catalog.models, opts.search);

  if (opts.json === true) {
    log(
      JSON.stringify(
        { marginPct: catalog.marginPct, updatedAt: catalog.updatedAt, models: matched },
        null,
        2,
      ),
    );
    return;
  }
  for (const line of formatModelList(matched, {
    marginPct: catalog.marginPct,
    all: opts.all === true,
    search: opts.search,
  })) {
    log(line);
  }
}

export async function runModelsShow(opts: ModelsShowOptions, deps: ModelsDeps): Promise<void> {
  const log = resolveLog(deps);
  const id = opts.id.trim();
  if (id.length === 0) {
    throw new CliError(
      "A model id is required.",
      "e.g. boardwalk models show anthropic/claude-opus-4.8",
    );
  }
  const { client } = await resolveOrgClient(deps, { token: opts.token });
  const catalog = await client.listModels();
  const model = catalog.models.find((m) => m.id === id) ?? null;

  if (opts.json === true) {
    log(JSON.stringify({ model: id, supported: model !== null, rate: model }, null, 2));
    return;
  }
  if (model === null) {
    throw new CliError(
      `Model "${id}" is not available on the managed lane.`,
      "Browse the catalog with `boardwalk models list` (or `--search <q>`).",
    );
  }
  for (const line of formatModelDetail(model, catalog.marginPct)) log(line);
}

// ── pure helpers (exported for tests) ────────────────────────────────────────────────────────────

/** Case-insensitive substring filter over id + display name; the whole list when there's no query. */
export function filterModels(models: ModelListItem[], search: string | undefined): ModelListItem[] {
  const q = search?.trim().toLowerCase();
  if (q === undefined || q.length === 0) return models;
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
}

/** Render the catalog as an aligned table. Without `--all`/`--search` it caps at DEFAULT_LIST_LIMIT
 *  (most-capable first), appending a hint about the remainder. */
export function formatModelList(
  models: ModelListItem[],
  opts: { marginPct: number; all: boolean; search: string | undefined },
): string[] {
  const searching = opts.search !== undefined && opts.search.trim().length > 0;
  if (models.length === 0) {
    return [
      searching ? `No models match "${opts.search ?? ""}".` : "No models available right now.",
    ];
  }
  const showAll = opts.all || searching;
  const shown = showAll ? models : models.slice(0, DEFAULT_LIST_LIMIT);
  const count = showAll
    ? String(models.length)
    : `${String(models.length)}, showing ${String(shown.length)}`;
  const lines = [
    `Managed models  (${count})  ·  prices per 1M tokens, ${String(opts.marginPct)}% margin included`,
    "",
    `  ${col("MODEL", NAME_W)}${col("ID", ID_W)}${col("INPUT", PRICE_W)}${col("OUTPUT", PRICE_W)}CONTEXT`,
  ];
  for (const m of shown) {
    lines.push(
      `  ${col(m.name, NAME_W)}${col(m.id, ID_W)}${col(usd(m.inputPerMtok), PRICE_W)}${col(usd(m.outputPerMtok), PRICE_W)}${formatContext(m.contextTokens)}`,
    );
  }
  if (!showAll && models.length > shown.length) {
    lines.push("");
    lines.push(
      `  … and ${String(models.length - shown.length)} more — \`boardwalk models list --all\` or \`--search <q>\`.`,
    );
  }
  return lines;
}

/** Render one model's detail block (for `models show`). */
export function formatModelDetail(m: ModelListItem, marginPct: number): string[] {
  return [
    m.name,
    `  id        ${m.id}`,
    `  input     ${usd(m.inputPerMtok)} / 1M tokens`,
    `  output    ${usd(m.outputPerMtok)} / 1M tokens`,
    `  context   ${formatContext(m.contextTokens)}`,
    `  supported yes — agent("…", { model: "${m.id}" })`,
    "",
    `Prices include the ${String(marginPct)}% managed margin. A BYO provider pays your own rate.`,
  ];
}

const NAME_W = 24;
const ID_W = 36;
const PRICE_W = 12;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}

/** USD/1M-tokens display: 2 dp for dollar-scale prices, up to 4 dp (trimmed) for sub-dollar ones. */
function usd(n: number): string {
  const s = n >= 1 ? n.toFixed(2) : String(Number(n.toFixed(4)));
  return `$${s}`;
}

/** Context window as a compact token count (200K, 1M), or "—" when the lane didn't report one. */
function formatContext(tokens: number | null): string {
  if (tokens === null || tokens <= 0) return "—";
  if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`;
  if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`;
  return String(tokens);
}
