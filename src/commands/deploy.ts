// SPDX-License-Identifier: MIT

// `boardwalk deploy <dir> [--org <slug>]` — ship a workflow package.
//
// Builds the artifact (descriptor + bundle + types harvest), uploads it, and finalizes the version;
// the server derives the I/O schemas from the harvest and may return derivation WARNINGS, printed
// here. Org resolution is deterministic (Decision 11): `--org` > a single-org credential's scope >
// the project link (.boardwalk/project.json) > a hard error listing the orgs — never a guess. A
// deploy that would CREATE a new workflow asks first (`--yes` skips, for CI). `--dry-run` prints
// the plan only.

import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { BoardwalkClient } from "../client.js";
import { CliError } from "../errors.js";
import { resolveLog } from "../log.js";
import { machineSummaryLine } from "../artifact.js";
import {
  deployWithLink,
  fetchCredentialOrgs,
  loadProgram,
  planDeploy,
  resolveDeployOrg,
  type DeployContext,
  type PreparedProgram,
} from "../deployment.js";
import { projectDirFor, readLink } from "../project.js";
import { stdioPrompter, type Prompter } from "../prompt.js";
import { resolveProjectRoot } from "../descriptor.js";
import { typecheckPackage, type TscRunner } from "../typecheck.js";
import type { FetchLike } from "../auth/pkce.js";

export interface DeployOptions {
  file: string;
  org?: string | undefined;
  check: boolean;
  token?: string | undefined;
  /** Skip the interactive create confirmation (CI). Update deploys never prompt. */
  yes?: boolean | undefined;
  /** Pack the TypeScript types harvest (machine layer). Default ON; `--no-types-harvest` opts out —
   *  the backend then has nothing to derive I/O schemas from. */
  typesHarvest?: boolean | undefined;
  /** Run the package's own tsc before shipping (default ON for TypeScript packages);
   *  `--no-typecheck` opts out. */
  typecheck?: boolean | undefined;
  /** `--run`: trigger the version this deploy just shipped, then report it like `run` does. */
  run?: boolean | undefined;
  /** Trigger payload for `--run` (ignored otherwise). */
  input?: string | undefined;
  /** Environment NAME for `--run` (ignored otherwise; omit = the org base). */
  environment?: string | undefined;
  /** `--no-wait` with `--run`: trigger and exit without polling. */
  noWait?: boolean | undefined;
}

export interface DeployDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Injected in tests; defaults to the real terminal prompter. */
  prompter?: Prompter;
  /** Whether stdin can prompt (defaults to the real TTY state). */
  interactive?: boolean;
  /** Test seam for the tsc invocation. */
  tscRunner?: TscRunner;
}

/**
 * The create-confirmation gate `deploy`/`run` hand to {@link deployWithLink}: undefined when the
 * caller passed `--yes` (skip), otherwise an interactive confirm — which HARD-ERRORS instead of
 * hanging when there is no TTY to ask (CI without --yes).
 */
export function makeCreateConfirmer(opts: {
  yes: boolean;
  interactive: boolean;
  prompter?: Prompter | undefined;
}): DeployContext["confirmCreate"] {
  if (opts.yes) return undefined;
  return async ({ slug, orgSlug }) => {
    if (!opts.interactive) {
      throw new CliError(
        `This deploy would CREATE a new workflow "${slug}" in org "${orgSlug}".`,
        "Re-run with --yes to confirm non-interactively.",
      );
    }
    // Prompt over stderr so stdout stays clean for machine output (`run --json` piping).
    const prompter =
      opts.prompter ?? stdioPrompter({ input: process.stdin, output: process.stderr });
    return prompter.confirm(`Create new workflow "${slug}" in org "${orgSlug}"?`);
  };
}

/** Print the server's schema-derivation warnings, when any came back (additive field). */
export function logDeployWarnings(log: (line: string) => void, warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  log("⚠ derivation warnings:");
  for (const w of warnings) log(`  - ${w}`);
}

export async function runDeploy(opts: DeployOptions, deps: DeployDeps): Promise<void> {
  const log = resolveLog(deps);

  const prog = await loadProgram(opts.file, { typesHarvest: opts.typesHarvest !== false });
  const assets = prog.artifact.assetPaths.length;
  log(
    `  built ${prog.entry} (${String(prog.artifact.size)} bytes${assets > 0 ? `, ${String(assets)} asset${assets === 1 ? "" : "s"}` : ""})`,
  );
  const machineSummary = machineSummaryLine(prog.artifact, opts.typesHarvest !== false);
  if (machineSummary !== null) log(`  ${machineSummary}`);

  // Type errors ship as runtime failures otherwise (the bundle is strip-only), and the loop most
  // authors live in is `deploy --run`, not `check` — so the gate belongs here too. Fail-soft when
  // the package has no tsc of its own; `--no-typecheck` opts out.
  if (prog.artifact.language !== "python" && opts.typecheck !== false) {
    const outcome = typecheckPackage(resolveProjectRoot(opts.file), deps.tscRunner);
    if (outcome.ran) log("  types:    OK (tsc --noEmit)");
  }

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

  if (opts.check) {
    await printPlan(client, opts, prog, log);
    return;
  }

  const dep = await deployWithLink(client, {
    orgSlug: opts.org,
    target: opts.file,
    prog,
    confirmCreate: makeCreateConfirmer({
      yes: opts.yes === true,
      interactive: deps.interactive ?? process.stdin.isTTY,
      prompter: deps.prompter,
    }),
  });
  if (dep.gitignoreUpdated)
    log("  linked → .boardwalk/project.json (added .boardwalk/ to .gitignore)");
  if (dep.ignoredFileSlug !== undefined)
    log(
      `⚠ this directory is linked to workflow "${dep.deployedSlug}" — the descriptor's slug "${dep.ignoredFileSlug}" was ignored (deployed as a new version of "${dep.deployedSlug}"). Deploy a different workflow from its own directory, or delete .boardwalk/ to re-link.`,
    );
  log(
    `✓ ${dep.outcome} "${dep.deployedSlug}" version ${String(dep.versionNumber)} (${dep.workflowId})`,
  );
  logDeployWarnings(log, dep.warnings);

  if (opts.run !== true) return;
  // The authoring loop in one command. `run` itself stays purely control-plane (it reads nothing
  // local), so "deploy this, then fire it" lives here — under the verb that already owns the code.
  const { triggerAndReport, parseInput } = await import("./run.js");
  await triggerAndReport(client, {
    orgSlug: dep.orgSlug,
    workflowId: dep.workflowId,
    input: parseInput(opts.input),
    environment: opts.environment,
    noWait: opts.noWait === true,
    jsonMode: false,
    log,
    emit: log,
  });
}

/** Read-only preview of what `deploy` would do (no writes, no prompts). */
async function printPlan(
  client: BoardwalkClient,
  opts: DeployOptions,
  prog: PreparedProgram,
  log: (line: string) => void,
): Promise<void> {
  const link = readLink(projectDirFor(opts.file));
  const orgSlug = resolveDeployOrg({
    orgFlag: opts.org,
    credentialOrgs: await fetchCredentialOrgs(client),
    linkOrg: link?.orgSlug ?? null,
  });
  if (link !== null && link.orgSlug === orgSlug) {
    log(`plan: UPDATE linked workflow ${link.workflowId} (org ${orgSlug}) → new version`);
    return;
  }
  const plan = planDeploy(await client.listWorkflows(orgSlug), prog.slug);
  log(
    plan.action === "create"
      ? `plan: CREATE "${prog.slug}" in org ${orgSlug}`
      : `plan: ADOPT existing "${prog.slug}" (${plan.workflowId ?? "?"}) → new version`,
  );
}
