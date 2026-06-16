// SPDX-License-Identifier: MIT

// `boardwalk inference` — manage the org's BYO inference providers (the `agent({ provider })`
// endpoints):
//   • inference list           → name/source/endpoint/key?/billing (API keys are never shown)
//   • inference add <name>      → register a provider; an --api-key (or piped stdin) is staged
//                                 server-side. Needs an ELEVATED login (`login --scopes admin`).
//   • inference delete <name>   → remove a provider (requires --yes; elevated)
//
// Providers created here are always bring-your-own (the org's own key pays the upstream); the server
// forces billed_by_boardwalk=false. The managed `boardwalk` lane needs no provider at all.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient } from "../org_client.js";
import type { ProviderListItem, CreateProviderInput } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

const SOURCES = [
  "bedrock",
  "anthropic",
  "google",
  "openai",
  "openai_compatible",
  "azure_openai",
] as const;
type Source = (typeof SOURCES)[number];

export interface InferenceListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface InferenceAddOptions {
  name: string;
  source?: string | undefined;
  baseUrl?: string | undefined;
  region?: string | undefined;
  apiVersion?: string | undefined;
  /** The provider API key inline (convenience; prefer piping it via stdin to keep it out of history). */
  apiKey?: string | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface InferenceDeleteOptions {
  name: string;
  yes?: boolean | undefined;
  org?: string | undefined;
  token?: string | undefined;
}

export interface InferenceDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
  now?: number;
  /** Read the API key from stdin when neither --api-key nor a key-less source is used (tests inject). */
  readStdin?: () => Promise<string>;
}

function logger(deps: InferenceDeps): (line: string) => void {
  return (
    deps.log ??
    ((line: string): void => {
      console.log(line);
    })
  );
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requireOrg(org: string | undefined): string {
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  return org;
}

function parseSource(value: string | undefined): Source {
  if (value === undefined || value.trim().length === 0) {
    throw new CliError("--source is required.", `One of: ${SOURCES.join(", ")}.`);
  }
  const v = value.trim();
  if (!(SOURCES as readonly string[]).includes(v)) {
    throw new CliError(`Invalid --source "${v}".`, `One of: ${SOURCES.join(", ")}.`);
  }
  return v as Source;
}

export async function runInferenceList(
  opts: InferenceListOptions,
  deps: InferenceDeps,
): Promise<void> {
  const log = logger(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const providers = await client.listProviders(requireOrg(org));
  if (opts.json === true) {
    log(JSON.stringify({ providers }, null, 2));
    return;
  }
  for (const line of formatProviders(requireOrg(org), providers)) log(line);
}

export async function runInferenceAdd(
  opts: InferenceAddOptions,
  deps: InferenceDeps,
): Promise<void> {
  const log = logger(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A provider name is required.");
  const source = parseSource(opts.source);

  const input: CreateProviderInput = { name, source };
  if (opts.baseUrl !== undefined) input.baseUrl = opts.baseUrl;
  if (opts.region !== undefined) input.region = opts.region;
  if (opts.apiVersion !== undefined) input.apiVersion = opts.apiVersion;

  // A key may come from --api-key or piped stdin. bedrock uses a role (no key); others usually need
  // one, but the server validates — we only forward what we were given.
  let apiKey = opts.apiKey;
  if (apiKey === undefined && deps.readStdin !== undefined) {
    const piped = (await deps.readStdin()).replace(/\r?\n$/, "");
    if (piped.length > 0) apiKey = piped;
  } else if (apiKey === undefined && !process.stdin.isTTY) {
    const piped = (await readAllStdin()).replace(/\r?\n$/, "");
    if (piped.length > 0) apiKey = piped;
  }
  if (apiKey !== undefined && apiKey.length > 0) input.apiKey = apiKey;

  const { client, org } = await resolveOrgClient(deps, opts);
  try {
    const row = await client.createProvider(requireOrg(org), input);
    log(`✓ added provider ${row.name} (${row.source}${row.hasApiKey ? ", key set" : ""}).`);
    if (row.source === "bedrock" && !row.hasApiKey) {
      log("  Bedrock uses a cross-account role — wire it in the web UI (bedrock-role).");
    }
  } catch (err) {
    throw elevationHint(err);
  }
}

export async function runInferenceDelete(
  opts: InferenceDeleteOptions,
  deps: InferenceDeps,
): Promise<void> {
  const log = logger(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A provider name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);

  if (opts.yes !== true) {
    log(`About to delete inference provider ${name} from ${resolvedOrg}.`);
    log("Workflows that `agent({ provider })` against it will fail until re-added.");
    log("Re-run with --yes to confirm:");
    log(`  boardwalk inference delete ${name} --yes`);
    return;
  }
  try {
    await client.deleteProvider(resolvedOrg, name);
    log(`✓ deleted provider ${name}.`);
  } catch (err) {
    throw elevationHint(err);
  }
}

/** On a 403 from a write, point at the elevated login (the common cause: a default CLI session). */
function elevationHint(err: unknown): unknown {
  if (err instanceof CliError && err.status === 403) {
    return new CliError(
      "This action needs an elevated session.",
      "Run `boardwalk login --scopes admin` (you must be an org admin), then retry.",
    );
  }
  return err;
}

// ── formatter (pure — exported for tests) ───────────────────────────────────────────────────────

/** Render the providers as an aligned table. API keys are never present to render. */
export function formatProviders(org: string, providers: ProviderListItem[]): string[] {
  if (providers.length === 0) {
    return [`No inference providers in ${org} — add one with \`boardwalk inference add <name>\`.`];
  }
  const lines = [
    `Inference providers · ${org}  (${String(providers.length)})`,
    "",
    `  ${col("NAME", NAME_W)}${col("SOURCE", SOURCE_W)}${col("ENDPOINT", ENDPOINT_W)}${col("KEY", KEY_W)}BILLING`,
  ];
  for (const p of providers) {
    lines.push(
      `  ${col(p.name, NAME_W)}${col(p.source, SOURCE_W)}${col(p.baseUrl ?? p.region ?? "—", ENDPOINT_W)}${col(p.hasApiKey ? "set" : "—", KEY_W)}${p.billedByBoardwalk ? "boardwalk" : "byo"}`,
    );
  }
  return lines;
}

const NAME_W = 22;
const SOURCE_W = 20;
const ENDPOINT_W = 34;
const KEY_W = 6;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}
