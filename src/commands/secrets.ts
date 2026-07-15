// SPDX-License-Identifier: MIT

// `boardwalk secrets` — manage the org's secrets catalog from the terminal:
//   • secrets list            → names/scope/kind/last4 (VALUES are never shown — they can't be read)
//   • secrets set <name>      → stage a value (from --value, --from-file, or stdin); needs an
//                               ELEVATED login (`boardwalk login --scopes admin`) or a bwk_ API key
//   • secrets delete <name>   → remove a secret (requires --yes; elevated)
//
// Values never touch argv by default — pipe them (`echo $TOKEN | boardwalk secrets set X`) or pass
// --from-file, so they can't leak into shell history. `--value` is accepted for convenience.

import { readFile } from "node:fs/promises";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import { readAllStdin } from "../stdin.js";
import type { SecretListItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

const SCOPES = ["org", "user"] as const;
const KINDS = ["api_key", "oauth_token", "aws_role", "mcp_credential"] as const;
type Scope = (typeof SCOPES)[number];
type Kind = (typeof KINDS)[number];

export interface SecretsListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface SecretSetOptions {
  name: string;
  /** The value inline (convenience; prefer stdin/--from-file so it stays out of shell history). */
  value?: string | undefined;
  /** Read the value from this file instead of stdin/--value. */
  fromFile?: string | undefined;
  scope?: string | undefined;
  kind?: string | undefined;
  description?: string | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface SecretDeleteOptions {
  name: string;
  scope?: string | undefined;
  yes?: boolean | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface SecretsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
  now?: number;
  /** Read the secret value from stdin (injected for tests). Defaults to reading process.stdin. */
  readStdin?: () => Promise<string>;
}

function parseScope(value: string | undefined): Scope {
  const v = (value ?? "org").trim();
  if (!(SCOPES as readonly string[]).includes(v)) {
    throw new CliError(`Invalid --scope "${v}".`, `One of: ${SCOPES.join(", ")} (default org).`);
  }
  return v as Scope;
}

function parseKind(value: string | undefined): Kind {
  const v = (value ?? "api_key").trim();
  if (!(KINDS as readonly string[]).includes(v)) {
    throw new CliError(`Invalid --kind "${v}".`, `One of: ${KINDS.join(", ")} (default api_key).`);
  }
  return v as Kind;
}

export async function runSecretsList(opts: SecretsListOptions, deps: SecretsDeps): Promise<void> {
  const log = resolveLog(deps);
  const now = deps.now ?? Date.now();
  const { client, org } = await resolveOrgClient(deps, opts);
  const secrets = await client.listSecrets(requireOrg(org));
  if (opts.json === true) {
    log(JSON.stringify({ secrets }, null, 2));
    return;
  }
  for (const line of formatSecrets(requireOrg(org), secrets, now)) log(line);
}

export async function runSecretSet(opts: SecretSetOptions, deps: SecretsDeps): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A secret name is required.");
  const scope = parseScope(opts.scope);
  const kind = parseKind(opts.kind);

  // Value precedence: --value > --from-file > stdin. Strip a single trailing newline (the common
  // `echo`/file artifact) but preserve any internal newlines (PEM keys, multi-line tokens).
  let value: string;
  if (opts.value !== undefined) {
    value = opts.value;
  } else if (opts.fromFile !== undefined) {
    value = await readFile(opts.fromFile, "utf8").catch((err: unknown) => {
      throw new CliError(
        `Could not read --from-file "${opts.fromFile ?? ""}".`,
        err instanceof Error ? err.message : undefined,
      );
    });
  } else {
    value = await (deps.readStdin ?? readAllStdin)();
  }
  value = value.replace(/\r?\n$/, "");
  if (value.length === 0) {
    throw new CliError(
      "No secret value provided.",
      "Pipe it (`echo $TOKEN | boardwalk secrets set NAME`), pass --from-file, or --value.",
    );
  }

  const { client, org } = await resolveOrgClient(deps, opts);
  const input: Parameters<typeof client.createSecret>[1] = { name, value, scope, kind };
  if (opts.description !== undefined) input.description = opts.description;
  try {
    const row = await client.createSecret(requireOrg(org), input);
    log(
      `✓ set secret ${row.name} (${row.scope}/${row.kind}${row.last4 !== null ? `, …${row.last4}` : ""}).`,
    );
  } catch (err) {
    throw elevationHint(err, "Writing a secret");
  }
}

export async function runSecretDelete(opts: SecretDeleteOptions, deps: SecretsDeps): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A secret name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);

  // The delete endpoint is keyed by id; resolve name (+ optional scope) against the catalog.
  const all = await client.listSecrets(resolvedOrg);
  const wantScope = opts.scope?.trim();
  const matches = all.filter((s) => s.name === name && (wantScope ? s.scope === wantScope : true));
  if (matches.length === 0) {
    throw new CliError(
      `No secret "${name}"${wantScope ? ` (scope ${wantScope})` : ""} in ${resolvedOrg}.`,
      "Check the name with `boardwalk secrets list`.",
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      `"${name}" matches ${String(matches.length)} secrets (different scopes).`,
      `Disambiguate with --scope ${matches.map((m) => m.scope).join(" / ")}.`,
    );
  }
  const target = matches[0];
  if (target === undefined) return;

  if (opts.yes !== true) {
    log(
      `About to delete secret ${target.name} (${target.scope}/${target.kind}) from ${resolvedOrg}.`,
    );
    log("This is irreversible. Re-run with --yes to confirm:");
    log(`  boardwalk secrets delete ${name}${wantScope ? ` --scope ${wantScope}` : ""} --yes`);
    return;
  }
  try {
    await client.deleteSecret(target.id);
    log(`✓ deleted secret ${target.name}.`);
  } catch (err) {
    throw elevationHint(err, "Deleting a secret");
  }
}

// ── formatter (pure — exported for tests) ───────────────────────────────────────────────────────

/** Render the secrets catalog as an aligned table. Values are never present to render. */
export function formatSecrets(org: string, secrets: SecretListItem[], now: number): string[] {
  if (secrets.length === 0) {
    return [`No secrets in ${org} yet — add one with \`boardwalk secrets set <name>\`.`];
  }
  const lines = [
    `Secrets · ${org}  (${String(secrets.length)})`,
    "",
    `  ${col("NAME", NAME_W)}${col("SCOPE", SCOPE_W)}${col("KIND", KIND_W)}${col("VALUE", VALUE_W)}CREATED`,
  ];
  for (const s of secrets) {
    lines.push(
      `  ${col(s.name, NAME_W)}${col(s.scope, SCOPE_W)}${col(s.kind, KIND_W)}${col(s.last4 !== null ? `…${s.last4}` : "—", VALUE_W)}${s.createdAt !== null ? age(s.createdAt, now) : "—"}`,
    );
  }
  return lines;
}

const NAME_W = 28;
const SCOPE_W = 7;
const KIND_W = 16;
const VALUE_W = 8;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}

function age(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.round(h / 24))}d ago`;
}
