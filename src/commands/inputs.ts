// SPDX-License-Identifier: MIT

// `boardwalk inputs [runId]` — list human-in-the-loop gates awaiting a response (the org inbox, or
// one run's gates with a runId), and `boardwalk respond <runId> <key>` — answer a gate, which
// resumes the run once its whole batch is answered. See docs/SUSPENSION.md.
//
// Auth + org precedence match the other network commands: --token > BOARDWALK_API_KEY > stored login;
// --org > the linked project's org. A single-run list / respond resolves the org from the run id.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { resolveLog } from "../log.js";
import { BoardwalkClient, type HumanInputItem } from "../client.js";
import { readLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface InputsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
  now?: number;
}

export interface InputsOptions {
  /** List one run's gates instead of the org inbox (the org is resolved from the run id). */
  runId?: string | undefined;
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export async function runInputs(opts: InputsOptions, deps: InputsDeps): Promise<void> {
  const log = resolveLog(deps);
  const client = await connect(opts.token, deps);
  const runId = (opts.runId ?? "").trim();

  const inputs =
    runId.length > 0
      ? await client.listRunInputs(runId, "pending")
      : await client.listOrgInputs(requireOrg(opts, deps));

  if (opts.json === true) {
    log(JSON.stringify({ inputs }, null, 2));
    return;
  }
  for (const line of formatInputs(inputs, runId.length > 0 ? runId : "your org")) log(line);
}

export interface RespondOptions {
  runId: string;
  key: string;
  /** A text answer / a single choice (an unlisted value is taken as open "other" text when allowed). */
  value?: string | undefined;
  /** Multi-select: a comma-separated list of options. */
  values?: string | undefined;
  /** The open-text entry for a multi-select "Other...". */
  other?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export async function runRespond(opts: RespondOptions, deps: InputsDeps): Promise<void> {
  const log = resolveLog(deps);
  const runId = opts.runId.trim();
  const key = opts.key.trim();
  if (runId.length === 0 || key.length === 0) {
    throw new CliError(
      "respond needs a run id and a gate key.",
      "Usage: boardwalk respond <runId> <key> --value yes",
    );
  }
  const submission = buildSubmission(opts);
  const client = await connect(opts.token, deps);
  await client.respondToInput(runId, key, submission);

  if (opts.json === true) {
    log(JSON.stringify({ runId, key, responded: true }, null, 2));
    return;
  }
  log(
    `Responded to "${key}" on run ${runId}. The run resumes once every pending input is answered.`,
  );
}

/** Turn the respond flags into the API submission. Exactly one of --value / --values must be given. */
function buildSubmission(opts: RespondOptions): {
  value?: string;
  values?: string[];
  other?: string;
} {
  const hasValue = opts.value !== undefined;
  const hasValues = opts.values !== undefined;
  if (hasValue && hasValues) {
    throw new CliError("Use either --value (text/choice) or --values (multi-select), not both.");
  }
  if (!hasValue && !hasValues && opts.other === undefined) {
    throw new CliError(
      "Provide an answer.",
      "Use --value <text> for text/choice, or --values a,b,c for multi-select.",
    );
  }
  if (hasValues) {
    const values = (opts.values ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    return {
      values,
      ...(opts.other !== undefined ? { other: opts.other } : {}),
    };
  }
  return {
    ...(opts.value !== undefined ? { value: opts.value } : {}),
    ...(opts.other !== undefined ? { other: opts.other } : {}),
  };
}

async function connect(tokenFlag: string | undefined, deps: InputsDeps): Promise<BoardwalkClient> {
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { token, baseUrl } = await resolveApiTarget({
    config: deps.config,
    store,
    tokenFlag,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  return new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

function requireOrg(opts: InputsOptions, deps: InputsDeps): string {
  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, run from a linked project, or pass a run id to list that run's inputs.",
    );
  }
  return org;
}

/** Render the gates as a readable block (pure — exported for tests). */
export function formatInputs(inputs: HumanInputItem[], scope: string): string[] {
  if (inputs.length === 0) return [`No inputs awaiting a response for ${scope}.`];
  const lines = [`Inputs awaiting a response · ${scope}  (${String(inputs.length)})`, ""];
  for (const i of inputs) {
    lines.push(`  ${i.runId}  ${i.key}`);
    lines.push(`    ${i.prompt}`);
    lines.push(`    ${describeForm(i.input)}`);
    if (i.assignees !== null && i.assignees.length > 0) {
      lines.push(`    assignees: ${i.assignees.join(", ")}`);
    }
    lines.push("");
  }
  lines.push("Answer one with:  boardwalk respond <runId> <key> --value <answer>");
  return lines;
}

/** A one-line hint of the response form (`text`, `choice: a | b`, `multiselect: a | b`). */
function describeForm(input: unknown): string {
  if (typeof input !== "object" || input === null || !("kind" in input)) return "text";
  const kind = input.kind;
  if (kind === "choice" || kind === "multiselect") {
    const options =
      "options" in input && Array.isArray(input.options)
        ? input.options.filter((o): o is string => typeof o === "string")
        : [];
    return `${kind}: ${options.join(" | ")}`;
  }
  return "text";
}
