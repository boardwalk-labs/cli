// SPDX-License-Identifier: MIT

// `boardwalk environments` — manage the org's named environments (a config set a run/schedule targets
// BY NAME; the org-level base always applies underneath):
//   • environments list            → id / name / description
//   • environments create <name>   → create a named environment (needs an elevated login / API key)
//   • environments delete <name>   → remove it (requires --yes; its variables go too)
//
// An environment holds non-secret variables (`boardwalk variables`) + secrets (`boardwalk secrets`).
// Pick which environment a run uses with `boardwalk run --environment <name>` — it is NOT a manifest
// field.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { EnvironmentItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface EnvironmentsListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface EnvironmentCreateOptions {
  name: string;
  description?: string | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface EnvironmentDeleteOptions {
  name: string;
  yes?: boolean | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface EnvironmentsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export async function runEnvironmentsList(
  opts: EnvironmentsListOptions,
  deps: EnvironmentsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const environments = await client.listEnvironments(requireOrg(org));
  if (opts.json === true) {
    log(JSON.stringify({ environments }, null, 2));
    return;
  }
  for (const line of formatEnvironments(requireOrg(org), environments)) log(line);
}

export async function runEnvironmentCreate(
  opts: EnvironmentCreateOptions,
  deps: EnvironmentsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("An environment name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const input: Parameters<typeof client.createEnvironment>[1] = { name };
  if (opts.description !== undefined) input.description = opts.description;
  try {
    const env = await client.createEnvironment(requireOrg(org), input);
    log(`✓ created environment ${env.name}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

export async function runEnvironmentDelete(
  opts: EnvironmentDeleteOptions,
  deps: EnvironmentsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("An environment name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);

  // The delete endpoint is keyed by id; resolve the name against the catalog.
  const target = (await client.listEnvironments(resolvedOrg)).find((e) => e.name === name);
  if (target === undefined) {
    throw new CliError(
      `No environment "${name}" in ${resolvedOrg}.`,
      "Check the name with `boardwalk environments list`.",
    );
  }
  if (opts.yes !== true) {
    log(`About to delete environment ${target.name} from ${resolvedOrg} (its variables go too).`);
    log("This is irreversible. Re-run with --yes to confirm:");
    log(`  boardwalk environments delete ${name} --yes`);
    return;
  }
  try {
    await client.deleteEnvironment(target.id);
    log(`✓ deleted environment ${target.name}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

// ── formatter (pure — exported for tests) ───────────────────────────────────────────────────────

export function formatEnvironments(org: string, environments: EnvironmentItem[]): string[] {
  if (environments.length === 0) {
    return [
      `No environments in ${org} yet — add one with \`boardwalk environments create <name>\`.`,
    ];
  }
  const lines = [
    `Environments · ${org}  (${String(environments.length)})`,
    "",
    `  ${col("NAME", NAME_W)}DESCRIPTION`,
  ];
  for (const e of environments) {
    lines.push(`  ${col(e.name, NAME_W)}${e.description ?? "—"}`);
  }
  return lines;
}

const NAME_W = 28;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}
