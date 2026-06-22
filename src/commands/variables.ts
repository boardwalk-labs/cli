// SPDX-License-Identifier: MIT

// `boardwalk variables` — manage the org's NON-secret environment variables (injected into a run's
// process.env; a program reads them via `process.env.NAME`). Values ARE shown — they're not secret.
// `--environment <name>` scopes to an environment (omit = the org-level base):
//   • variables list [--environment <name>]            → name / environment / value
//   • variables set <name> <value> [--environment]     → create or update (needs elevated login)
//   • variables delete <name> [--environment]          → remove (requires --yes)
//
// For a SECRET value use `boardwalk secrets` instead — never store a credential as a variable.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { BoardwalkClient, VariableItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface VariablesListOptions {
  environment?: string | undefined;
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface VariableSetOptions {
  name: string;
  value: string;
  environment?: string | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface VariableDeleteOptions {
  name: string;
  environment?: string | undefined;
  yes?: boolean | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface VariablesDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

/** One variable joined to its environment NAME (null = the org base). */
interface VariableView {
  id: string;
  name: string;
  value: string;
  environment: string | null;
}

/** Resolve an environment NAME → id (null = the org base). Throws a helpful error on an unknown name. */
async function resolveEnvironmentId(
  client: BoardwalkClient,
  org: string,
  name: string | undefined,
): Promise<string | null> {
  if (name === undefined) return null;
  const match = (await client.listEnvironments(org)).find((e) => e.name === name);
  if (match === undefined) {
    throw new CliError(
      `No environment "${name}" in ${org}.`,
      "List them with `boardwalk environments list`, or omit --environment for the org base.",
    );
  }
  return match.id;
}

/** Join variables to their environment names for display. */
async function loadVariableViews(client: BoardwalkClient, org: string): Promise<VariableView[]> {
  const [variables, environments] = await Promise.all([
    client.listVariables(org),
    client.listEnvironments(org),
  ]);
  const envName = new Map(environments.map((e) => [e.id, e.name]));
  return variables.map((v: VariableItem) => ({
    id: v.id,
    name: v.name,
    value: v.value,
    environment: v.environmentId === null ? null : (envName.get(v.environmentId) ?? null),
  }));
}

export async function runVariablesList(
  opts: VariablesListOptions,
  deps: VariablesDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  let rows = await loadVariableViews(client, resolvedOrg);
  if (opts.environment !== undefined) rows = rows.filter((v) => v.environment === opts.environment);
  if (opts.json === true) {
    log(JSON.stringify({ variables: rows }, null, 2));
    return;
  }
  for (const line of formatVariables(resolvedOrg, rows)) log(line);
}

export async function runVariableSet(opts: VariableSetOptions, deps: VariablesDeps): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A variable name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  const environmentId = await resolveEnvironmentId(client, resolvedOrg, opts.environment);
  const where = opts.environment !== undefined ? ` in ${opts.environment}` : "";
  try {
    const variable = await client.createVariable(resolvedOrg, {
      name,
      value: opts.value,
      environmentId,
    });
    log(`✓ set variable ${variable.name}${where}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

export async function runVariableDelete(
  opts: VariableDeleteOptions,
  deps: VariablesDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A variable name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  const environmentId = await resolveEnvironmentId(client, resolvedOrg, opts.environment);
  const where = opts.environment !== undefined ? ` in ${opts.environment}` : "";

  // The delete endpoint is keyed by id; resolve (name, environment) against the catalog.
  const target = (await client.listVariables(resolvedOrg)).find(
    (v) => v.name === name && v.environmentId === environmentId,
  );
  if (target === undefined) {
    throw new CliError(
      `No variable "${name}"${where} in ${resolvedOrg}.`,
      "Check it with `boardwalk variables list`.",
    );
  }
  if (opts.yes !== true) {
    const envFlag = opts.environment !== undefined ? ` --environment ${opts.environment}` : "";
    log(`About to delete variable ${target.name}${where} from ${resolvedOrg}.`);
    log("Re-run with --yes to confirm:");
    log(`  boardwalk variables delete ${name}${envFlag} --yes`);
    return;
  }
  try {
    await client.deleteVariable(target.id);
    log(`✓ deleted variable ${target.name}${where}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

// ── formatter (pure — exported for tests) ───────────────────────────────────────────────────────

export function formatVariables(org: string, variables: VariableView[]): string[] {
  if (variables.length === 0) {
    return [
      `No variables in ${org} yet — add one with \`boardwalk variables set <name> <value>\`.`,
    ];
  }
  const lines = [
    `Variables · ${org}  (${String(variables.length)})`,
    "",
    `  ${col("NAME", NAME_W)}${col("ENVIRONMENT", ENV_W)}VALUE`,
  ];
  for (const v of variables) {
    lines.push(`  ${col(v.name, NAME_W)}${col(v.environment ?? "(base)", ENV_W)}${v.value}`);
  }
  return lines;
}

const NAME_W = 28;
const ENV_W = 16;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}
