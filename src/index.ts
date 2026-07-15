// SPDX-License-Identifier: MIT

// boardwalk CLI entrypoint — argument parsing + command dispatch (commander).
//
// Commands:
//   boardwalk init [dir]                Scaffold a new workflow project from a template.
//   boardwalk dev <file>                Run the workflow now, locally (no account needed).
//   boardwalk check <file>              Validate a workflow locally (no auth/network).
//   boardwalk login                     Authenticate via browser (OAuth PKCE).
//   boardwalk logout                    Remove local credentials.
//   boardwalk whoami                    Show the current session + orgs with ids (org lines are
//                                       best-effort network; the session line still prints offline).
//   boardwalk status                    Show host, login (live-verified), and project link.
//   boardwalk deploy <file> --org <s>   Create/update a workflow from a program file.
//   boardwalk run <file> --org <s>      Deploy + trigger a real run, wait for the result.
//   boardwalk cancel <runId>            Cancel a queued or in-flight run.
//   boardwalk usage --org <s>           Show org usage: runs, compute, tokens, credit, cache.
//   boardwalk runs [runId] [--logs|--follow]  List recent runs, show one, or stream its logs.
//   boardwalk webhook <ref> [--rotate]        Show a workflow's inbound webhook URL (--rotate mints).
//   boardwalk workflows [list|show|delete]    Inspect the org's workflows.
//   boardwalk secrets [list|set|delete]       Manage org secrets (writes need login --scopes admin).
//   boardwalk environments [list|create|delete]  Manage named environments (config sets a run targets).
//   boardwalk runner [start|register|list|remove|pools]  Run workflows on THIS machine (self-hosted runner).
//   boardwalk variables [list|set|delete]     Manage non-secret env variables (injected as process.env).
//   boardwalk inference [list|add|delete]     Manage BYO inference providers (writes need elevated).
//
// Auth precedence for deploy/run/cancel/usage/runs/workflows: --token > BOARDWALK_API_KEY env >
// stored `login`. The API host follows the same source: an explicit BOARDWALK_API_URL/DOMAIN wins,
// else the stored session's own origin (so a dev/self-host login just works), else the prod default.
//
// Every command body is lazy-imported inside its action — `boardwalk --help` must stay fast, so
// nothing heavy (esbuild, the SDK extractor, the API client) loads until its command actually runs.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { CliError } from "./errors.js";
import { loadConfig } from "./config.js";
import { assertNodeRuntime } from "./runtime_guard.js";
import { lazyImport } from "./lazy_import.js";

// The local-engine command modules (`dev`, `runner`) are loaded by a NON-STATIC specifier so Bun's
// `--compile` does NOT bundle them into the single-file binary: their graph pulls
// @boardwalk-labs/engine → `node:sqlite`, which Bun lacks and eagerly resolves at startup (crashing
// EVERY command). The `import()` type keeps them fully typed; callers `assertNodeRuntime()` first, so
// under the binary the user gets a clear pointer to the Node build. (eslint bans `import()` type
// annotations by default — here it is deliberate and load-bearing, so scope the rule off.)
/* eslint-disable @typescript-eslint/consistent-type-imports */
const loadDev = () => lazyImport<typeof import("./commands/dev.js")>("./commands/dev.js");
const loadRunner = () => lazyImport<typeof import("./commands/runner.js")>("./commands/runner.js");
/* eslint-enable @typescript-eslint/consistent-type-imports */

// Injected at Bun compile time via `--define` (see the release workflow's `binaries` job): the
// single-file binary has no package.json on disk to read, so the version is baked in at build. Under
// Node this identifier is undeclared (only `typeof` is safe), and readVersion() reads package.json.
declare const __BOARDWALK_CLI_VERSION__: string | undefined;

// Read the version from package.json (one level up from both src/ and dist/) so `--version`
// can never drift from the published package. Cheap sync read at load — doesn't touch the
// lazy-import budget that keeps `--help` fast. In the compiled binary the injected constant wins.
function readVersion(): string {
  if (typeof __BOARDWALK_CLI_VERSION__ === "string") return __BOARDWALK_CLI_VERSION__;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version: unknown = parsed.version;
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Fall through — a missing/unreadable package.json shouldn't break the CLI.
  }
  return "0.0.0";
}

const VERSION = readVersion();

interface DeployCliOptions {
  org?: string;
  dryRun?: boolean;
  token?: string;
}

interface RunCliOptions {
  org?: string;
  input?: string;
  environment?: string;
  token?: string;
  wait?: boolean;
  json?: boolean;
}

interface DevCliOptions {
  input?: string;
  env?: string;
  verbose?: boolean;
  stream?: string;
  org?: string;
  token?: string;
}

interface BuildCliOptions {
  out?: string;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("boardwalk")
    .description("Boardwalk CLI: author and ship agent workflows.")
    .version(VERSION);

  program
    .command("init")
    .argument("[dir]", "directory to scaffold into (created if missing)", ".")
    .option(
      "--template <name>",
      "template: the built-in `hello`, or any name from the examples registry",
      "hello",
    )
    .description("Scaffold a new workflow project from a template.")
    .action(async (dir: string, options: { template?: string }) => {
      const { runInit } = await import("./commands/init.js");
      await runInit({ dir, template: options.template ?? "hello" });
    });

  program
    .command("dev")
    .argument("<file>", "workflow program file, or a package directory")
    .option("--input <json>", "trigger payload exposed to the program as `input`")
    // Named --env (not --env-file): Node ≥26 claims --env-file even after the script path,
    // so that spelling would be processed (or rejected) by node itself before we ever parse it.
    .option("--env <path>", "env file resolving secrets for the run (default: .env)")
    .option("--verbose", "stream every event channel (agent turns, tool calls, logs)", false)
    .option("--stream <channels>", "comma-separated channels: lifecycle,phase,output,log,agent")
    // agent() with no provider uses Boardwalk managed inference; --org bills it (else the project
    // link's org, else set BOARDWALK_API_KEY / name a provider). Needs `boardwalk login`.
    .option("--org <slug>", "org to bill managed inference to (for agent() with no provider)")
    .option("--token <token>", "bearer to mint the inference key with, instead of stored login")
    .description("Run the workflow now, locally (no account needed).")
    .action(async (file: string, options: DevCliOptions) => {
      // `dev` runs a local engine (→ @boardwalk-labs/engine → node:sqlite), which the Bun single-file
      // binary can't host; guard first, then load via a non-static specifier so it's not bundled.
      assertNodeRuntime("dev");
      const { runDev } = await loadDev();
      await runDev({
        file,
        input: options.input,
        envFile: options.env,
        verbose: options.verbose ?? false,
        stream: options.stream,
        org: options.org,
        token: options.token,
      });
    });

  program
    .command("check")
    .argument("<file>", "workflow program file, or a package directory")
    .description("Validate a workflow locally (no auth, no network).")
    .action(async (file: string) => {
      const { runCheck } = await import("./commands/check.js");
      await runCheck({ file });
    });

  program
    .command("build")
    .argument("<file>", "workflow program file, or a package directory")
    .option("--out <path>", "output file (default: <workflow-name>.mjs in the cwd)")
    .description(
      "Bundle a workflow to one deployable .mjs (for a self-hosted server's workflows dir).",
    )
    .action(async (file: string, options: BuildCliOptions) => {
      const { runBuild } = await import("./commands/build.js");
      await runBuild({ file, out: options.out });
    });

  program
    .command("login")
    .description("Authenticate via browser (OAuth PKCE), or store an API key with --token.")
    .option("--token <key>", "store this API key (bwk_…) instead of the browser flow")
    .option(
      "--scopes <tier>",
      "elevated tier `admin` for org-admin writes (secrets, inference providers, workflow delete)",
    )
    .action(async (options: { token?: string; scopes?: string }) => {
      const { runLogin } = await import("./commands/session.js");
      await runLogin({ config: loadConfig() }, { token: options.token, scopes: options.scopes });
    });

  program
    .command("logout")
    .description("Remove local credentials.")
    .action(async () => {
      const { runLogout } = await import("./commands/session.js");
      runLogout({ config: loadConfig() });
    });

  program
    .command("whoami")
    .description("Show the current session and the account's orgs (slug, role, org id).")
    .action(async () => {
      const { runWhoami } = await import("./commands/session.js");
      await runWhoami({ config: loadConfig() });
    });

  program
    .command("status")
    .option("--token <token>", "verify this Bearer token instead of stored/env credentials")
    .description("Show the API host, login status (live-verified), and the project link.")
    .action(async (options: { token?: string }) => {
      const { runStatus } = await import("./commands/status.js");
      await runStatus({ token: options.token }, { config: loadConfig(), version: VERSION });
    });

  program
    .command("deploy")
    .argument("<file>", "workflow program file, or a package directory")
    .option("--org <slug>", "the org to deploy into (optional once the project is linked)")
    .option("--dry-run", "print the plan (create vs update) without writing", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Create or update a workflow from a program file.")
    .action(async (file: string, options: DeployCliOptions) => {
      const { runDeploy } = await import("./commands/deploy.js");
      await runDeploy(
        {
          file,
          org: options.org,
          check: options.dryRun ?? false,
          token: options.token,
        },
        { config: loadConfig() },
      );
    });

  program
    .command("run")
    .argument("<file>", "workflow program file, or a package directory")
    .option("--org <slug>", "the org to run in (optional once the project is linked)")
    .option("--input <json>", "trigger payload exposed to the program as `input`")
    .option(
      "--environment <name>",
      "environment to run in (its secrets + variables; default: org base)",
    )
    .option("--no-wait", "trigger and exit without waiting for the run to finish")
    .option(
      "--json",
      "print a JSON object ({ runId, status, ... }) on stdout; progress to stderr",
      false,
    )
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Deploy the program, trigger a real run, and wait for the result.")
    .action(async (file: string, options: RunCliOptions) => {
      const { runRun } = await import("./commands/run.js");
      await runRun(
        {
          file,
          org: options.org,
          input: options.input,
          environment: options.environment,
          noWait: options.wait === false,
          json: options.json,
          token: options.token,
        },
        { config: loadConfig() },
      );
    });

  program
    .command("cancel")
    .argument("<runId>", "the run to cancel")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Cancel a queued or in-flight run.")
    .action(async (runId: string, options: { token?: string }) => {
      const { runCancel } = await import("./commands/cancel.js");
      await runCancel({ runId, token: options.token }, { config: loadConfig() });
    });

  program
    .command("usage")
    .option("--org <slug>", "the org to report on (optional once the project is linked)")
    .option("--days <n>", "window length in days (server default ~14, capped at 90)")
    .option("--json", "print the raw usage summary as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Show your org's runs, compute, tokens, credit, autonomy, and cache-hit rate.")
    .action(async (options: { org?: string; days?: string; json?: boolean; token?: string }) => {
      const { runUsage } = await import("./commands/usage.js");
      await runUsage(
        { org: options.org, days: options.days, json: options.json, token: options.token },
        { config: loadConfig() },
      );
    });

  program
    .command("runs")
    .argument(
      "[runId]",
      "act on this run (detail by default; with --logs/--follow); no --org needed",
    )
    .option("--org <slug>", "the org to list runs for (optional once the project is linked)")
    .option("--workflow <ref>", "filter the list to one workflow (id or slug)")
    .option("--status <status>", "filter by status (e.g. running, completed, failed, cancelled)")
    .option("--limit <n>", "how many runs to show (server-clamped)")
    .option("--logs", "print the run's event log (needs a runId)", false)
    .option("--follow", "live-tail the run's events until it finishes (needs a runId)", false)
    .option("--verbose", "with --logs/--follow: render every event channel", false)
    .option(
      "--stream <channels>",
      "with --logs/--follow: comma-separated channels (lifecycle,phase,output,log,agent)",
    )
    .option(
      "--json-stream",
      "with --logs/--follow: emit every event as one line of NDJSON (all channels, no ANSI)",
      false,
    )
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description(
      "List your org's recent runs, show one run's detail, or stream its logs (`runs <id> --logs/--follow`).",
    )
    .action(
      async (
        runId: string | undefined,
        options: {
          org?: string;
          workflow?: string;
          status?: string;
          limit?: string;
          logs?: boolean;
          follow?: boolean;
          verbose?: boolean;
          stream?: string;
          jsonStream?: boolean;
          json?: boolean;
          token?: string;
        },
      ) => {
        const { runRuns } = await import("./commands/runs.js");
        // --follow tails until terminal; wire Ctrl-C to a clean abort so the stream closes tidily.
        const controller = new AbortController();
        if (options.follow === true) {
          process.once("SIGINT", () => {
            controller.abort();
          });
        }
        await runRuns(
          {
            runId,
            org: options.org,
            workflow: options.workflow,
            status: options.status,
            limit: options.limit,
            logs: options.logs,
            follow: options.follow,
            verbose: options.verbose,
            stream: options.stream,
            jsonStream: options.jsonStream,
            json: options.json,
            token: options.token,
          },
          { config: loadConfig(), signal: controller.signal },
        );
      },
    );

  program
    .command("inputs")
    .argument("[runId]", "list one run's pending inputs (omit for the org-wide inbox)")
    .option("--org <slug>", "the org for the inbox (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List human-in-the-loop inputs awaiting a response (the org inbox, or one run's).")
    .action(
      async (
        runId: string | undefined,
        options: { org?: string; json?: boolean; token?: string },
      ) => {
        const { runInputs } = await import("./commands/inputs.js");
        await runInputs(
          { runId, org: options.org, json: options.json, token: options.token },
          { config: loadConfig() },
        );
      },
    );

  program
    .command("respond")
    .argument("<runId>", "the run with the pending input")
    .argument("<key>", "the input's key (from `boardwalk inputs`)")
    .option("--value <text>", "the answer for a text or single-choice gate")
    .option("--values <a,b,c>", "comma-separated selections for a multi-select gate")
    .option("--other <text>", 'the open-text "Other..." entry for a choice / multi-select gate')
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Answer a human-in-the-loop input, resuming the run once its batch is answered.")
    .action(
      async (
        runId: string,
        key: string,
        options: {
          value?: string;
          values?: string;
          other?: string;
          json?: boolean;
          token?: string;
        },
      ) => {
        const { runRespond } = await import("./commands/inputs.js");
        await runRespond(
          {
            runId,
            key,
            value: options.value,
            values: options.values,
            other: options.other,
            json: options.json,
            token: options.token,
          },
          { config: loadConfig() },
        );
      },
    );

  program
    .command("webhook")
    .argument("<ref>", "workflow id (a ULID) or slug")
    .option("--org <slug>", "the org (needed to resolve a slug; optional once linked)")
    .option("--rotate", "regenerate the secret and reveal the full working URL once (admin)", false)
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Show a workflow's inbound webhook URL, or rotate its secret with --rotate.")
    .action(
      async (
        ref: string,
        options: { org?: string; rotate?: boolean; json?: boolean; token?: string },
      ) => {
        const { runWebhook } = await import("./commands/webhook.js");
        await runWebhook(
          {
            ref,
            org: options.org,
            rotate: options.rotate,
            json: options.json,
            token: options.token,
          },
          { config: loadConfig() },
        );
      },
    );

  registerWorkflowsCommand(program);
  registerSecretsCommand(program);
  registerEnvironmentsCommand(program);
  registerRunnerCommand(program);
  registerVariablesCommand(program);
  registerInferenceCommand(program);
  registerModelsCommand(program);
  registerNotificationsCommand(program);

  return program;
}

/** Register `workflows` + its `list` / `show` / `delete` subcommands (bare `workflows` ⇒ list). */
function registerWorkflowsCommand(program: Command): void {
  const workflows = program
    .command("workflows")
    .description("Inspect + control your org's workflows (list, show, disable, enable, delete).");

  workflows
    .command("list", { isDefault: true })
    .option("--org <slug>", "the org to list (optional once the project is linked)")
    .option(
      "-q, --search <term>",
      "only workflows whose title or slug contains this (case-insensitive)",
    )
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's workflows.")
    .action(async (options: { org?: string; search?: string; json?: boolean; token?: string }) => {
      const { runWorkflowsList } = await import("./commands/workflows.js");
      await runWorkflowsList(
        { org: options.org, search: options.search, json: options.json, token: options.token },
        { config: loadConfig() },
      );
    });

  workflows
    .command("show")
    .argument("<ref>", "workflow id (a ULID) or slug")
    .option("--org <slug>", "the org (needed to resolve a slug; optional once linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Show one workflow's manifest projection + versions.")
    .action(async (ref: string, options: { org?: string; json?: boolean; token?: string }) => {
      const { runWorkflowShow } = await import("./commands/workflows.js");
      await runWorkflowShow(
        { ref, org: options.org, json: options.json, token: options.token },
        { config: loadConfig() },
      );
    });

  workflows
    .command("disable")
    .argument("<ref>", "workflow id (a ULID) or slug")
    .option("--org <slug>", "the org (needed to resolve a slug; optional once linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Disable a workflow — pauses every trigger (reversible with enable).")
    .action(async (ref: string, options: { org?: string; token?: string }) => {
      const { runWorkflowDisable } = await import("./commands/workflows.js");
      await runWorkflowDisable(
        { ref, org: options.org, token: options.token },
        { config: loadConfig() },
      );
    });

  workflows
    .command("enable")
    .argument("<ref>", "workflow id (a ULID) or slug")
    .option("--org <slug>", "the org (needed to resolve a slug; optional once linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Enable a disabled workflow — resumes its triggers.")
    .action(async (ref: string, options: { org?: string; token?: string }) => {
      const { runWorkflowEnable } = await import("./commands/workflows.js");
      await runWorkflowEnable(
        { ref, org: options.org, token: options.token },
        { config: loadConfig() },
      );
    });

  workflows
    .command("delete")
    .argument("<ref>", "workflow id (a ULID) or slug")
    .option("--org <slug>", "the org (needed to resolve a slug; optional once linked)")
    .option("--yes", "actually delete — without it, prints the target and exits", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Delete a workflow (irreversible — versions + run history go with it).")
    .action(async (ref: string, options: { org?: string; yes?: boolean; token?: string }) => {
      const { runWorkflowDelete } = await import("./commands/workflows.js");
      await runWorkflowDelete(
        { ref, org: options.org, yes: options.yes, token: options.token },
        { config: loadConfig() },
      );
    });
}

/** Register `secrets` + its `list` / `set` / `delete` subcommands (writes need `login --scopes admin`). */
function registerSecretsCommand(program: Command): void {
  const secrets = program
    .command("secrets")
    .description("Manage the org's secrets (list, set, delete). Values are never displayed.");

  secrets
    .command("list", { isDefault: true })
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's secrets (names/scope/kind only — never values).")
    .action(async (options: { org?: string; json?: boolean; token?: string }) => {
      const { runSecretsList } = await import("./commands/secrets.js");
      await runSecretsList(options, { config: loadConfig() });
    });

  secrets
    .command("set")
    .argument("<name>", "secret name (referenced in a manifest's permissions.secrets)")
    .option("--value <value>", "the value inline (prefer piping via stdin / --from-file)")
    .option("--from-file <path>", "read the value from this file")
    .option("--scope <scope>", "org | user (default org)")
    .option("--kind <kind>", "api_key | oauth_token | aws_role | mcp_credential (default api_key)")
    .option("--description <text>", "optional human description")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Set a secret value (staged server-side). Needs `boardwalk login --scopes admin`.")
    .action(
      async (
        name: string,
        options: {
          value?: string;
          fromFile?: string;
          scope?: string;
          kind?: string;
          description?: string;
          org?: string;
          token?: string;
        },
      ) => {
        const { runSecretSet } = await import("./commands/secrets.js");
        await runSecretSet({ name, ...options }, { config: loadConfig() });
      },
    );

  secrets
    .command("delete")
    .argument("<name>", "secret name")
    .option("--scope <scope>", "disambiguate when a name exists in multiple scopes (org|user)")
    .option("--yes", "actually delete — without it, prints the target and exits", false)
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Delete a secret (irreversible). Needs `boardwalk login --scopes admin`.")
    .action(
      async (
        name: string,
        options: { scope?: string; yes?: boolean; org?: string; token?: string },
      ) => {
        const { runSecretDelete } = await import("./commands/secrets.js");
        await runSecretDelete({ name, ...options }, { config: loadConfig() });
      },
    );
}

/** Register `notifications` + its `list` / `unread` / `read` subcommands (the caller's own feed). */
function registerNotificationsCommand(program: Command): void {
  const notifications = program
    .command("notifications")
    .description("Your in-app notifications for the org (watched runs, input requests, billing).");

  notifications
    .command("list", { isDefault: true })
    .option("--unread", "only unread notifications", false)
    .option("--limit <n>", "max notifications to return")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List your notifications for the org (newest first).")
    .action(
      async (options: {
        unread?: boolean;
        limit?: string;
        org?: string;
        json?: boolean;
        token?: string;
      }) => {
        const { runNotificationsList } = await import("./commands/notifications.js");
        await runNotificationsList(options, { config: loadConfig() });
      },
    );

  notifications
    .command("unread")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Print your unread-notification count for the org (a bare number).")
    .action(async (options: { org?: string; json?: boolean; token?: string }) => {
      const { runNotificationsUnread } = await import("./commands/notifications.js");
      await runNotificationsUnread(options, { config: loadConfig() });
    });

  notifications
    .command("read")
    .argument("[ids...]", "notification ids to mark read")
    .option("--all", "mark every unread notification read", false)
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Mark notifications read — by id, or --all.")
    .action(
      async (
        ids: string[],
        options: { all?: boolean; org?: string; json?: boolean; token?: string },
      ) => {
        const { runNotificationsRead } = await import("./commands/notifications.js");
        await runNotificationsRead({ ids, ...options }, { config: loadConfig() });
      },
    );
}

/** Register `environments` + its `list` / `create` / `delete` subcommands (writes need elevation). */
function registerRunnerCommand(program: Command): void {
  const runner = program
    .command("runner")
    .description("Run Boardwalk workflows on THIS machine (a self-hosted runner).");

  runner
    .command("start", { isDefault: true })
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--pool <name>", "runner pool to serve (created on first use)", "default")
    .option("--name <name>", "machine name shown in the dashboard (default: hostname)")
    .option("--labels <a,b>", "extra labels for runs_on matching, comma-separated")
    .option("--once", "execute one run, then exit", false)
    .option("--work-dir <dir>", "root for per-run workspaces")
    .option("--host", "run WITHOUT isolation: full machine access (trusted workflows only)", false)
    .option("--image <ref>", "runner image for containerized runs (default: version-pinned)")
    .option("--network <mode>", "container network mode (default: host)")
    .option("--mount <a:b,…>", "extra host paths to expose to the run, comma-separated")
    .option("--verbose", "debug-level daemon logs (poll cycles, heartbeats)", false)
    .option("--debug", "verbose, plus debug logging inside each run process", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description(
      "Register this machine (admin role; plain `boardwalk login` is enough) and go online. " +
        "Runs are containerized by default (--host to opt out). Workflows target it with " +
        'runs_on: { kind: "self-hosted" }. Ctrl-C drains.',
    )
    .action(
      async (options: {
        org?: string;
        pool?: string;
        name?: string;
        labels?: string;
        once?: boolean;
        workDir?: string;
        host?: boolean;
        image?: string;
        network?: string;
        mount?: string;
        verbose?: boolean;
        debug?: boolean;
        token?: string;
      }) => {
        assertNodeRuntime("runner start");
        const { runRunnerStart } = await loadRunner();
        await runRunnerStart(options, { config: loadConfig() });
      },
    );

  runner
    .command("register")
    .requiredOption("--url <origin>", "the Boardwalk API origin, e.g. https://api.boardwalk.sh")
    .requiredOption("--token <bwkreg>", "one-time registration token (Settings > Runners)")
    .option("--name <name>", "machine name (default: hostname)")
    .option("--labels <a,b>", "extra labels, comma-separated")
    .description("Fleet flow: redeem a registration token minted elsewhere; then `runner start`.")
    .action(async (options: { url: string; token: string; name?: string; labels?: string }) => {
      assertNodeRuntime("runner register");
      const { runRunnerRegister } = await loadRunner();
      await runRunnerRegister(
        {
          url: options.url,
          registrationToken: options.token,
          name: options.name,
          labels: options.labels,
        },
        { config: loadConfig() },
      );
    });

  runner
    .command("list")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's self-hosted runners (status, pool, labels, last seen).")
    .action(async (options: { org?: string; json?: boolean; token?: string }) => {
      assertNodeRuntime("runner list");
      const { runRunnerList } = await loadRunner();
      await runRunnerList(options, { config: loadConfig() });
    });

  runner
    .command("remove")
    .argument("<runnerId>", "runner id (from `runner list`)")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--yes", "confirm: the runner's credential dies immediately", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Deregister a runner.")
    .action(async (runnerId: string, options: { org?: string; yes?: boolean; token?: string }) => {
      assertNodeRuntime("runner remove");
      const { runRunnerRemove } = await loadRunner();
      await runRunnerRemove({ runnerId, ...options }, { config: loadConfig() });
    });

  const pools = runner.command("pools").description("Runner pool utilities.");
  pools
    .command("token")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--pool <name>", "pool to mint for (created if absent)", "default")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Mint a one-time registration token for fleet installs (shown once, 1h TTL).")
    .action(async (options: { org?: string; pool?: string; token?: string }) => {
      assertNodeRuntime("runner pools token");
      const { runRunnerPoolToken } = await loadRunner();
      await runRunnerPoolToken(options, { config: loadConfig() });
    });
}

function registerEnvironmentsCommand(program: Command): void {
  const environments = program
    .command("environments")
    .description("Manage the org's named environments (list, create, delete).");

  environments
    .command("list", { isDefault: true })
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's named environments.")
    .action(async (options: { org?: string; json?: boolean; token?: string }) => {
      const { runEnvironmentsList } = await import("./commands/environments.js");
      await runEnvironmentsList(options, { config: loadConfig() });
    });

  environments
    .command("create")
    .argument("<name>", "environment name, e.g. Production")
    .option("--description <text>", "optional human description")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Create a named environment. Needs `boardwalk login --scopes admin`.")
    .action(
      async (name: string, options: { description?: string; org?: string; token?: string }) => {
        const { runEnvironmentCreate } = await import("./commands/environments.js");
        await runEnvironmentCreate({ name, ...options }, { config: loadConfig() });
      },
    );

  environments
    .command("delete")
    .argument("<name>", "environment name")
    .option("--yes", "actually delete — without it, prints the target and exits", false)
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Delete an environment (irreversible; its variables go too). Needs admin.")
    .action(async (name: string, options: { yes?: boolean; org?: string; token?: string }) => {
      const { runEnvironmentDelete } = await import("./commands/environments.js");
      await runEnvironmentDelete({ name, ...options }, { config: loadConfig() });
    });
}

/** Register `variables` + its `list` / `set` / `delete` subcommands (NON-secret config; writes need elevation). */
function registerVariablesCommand(program: Command): void {
  const variables = program
    .command("variables")
    .description("Manage the org's non-secret environment variables (list, set, delete).");

  variables
    .command("list", { isDefault: true })
    .option("--environment <name>", "only variables in this environment (default: all)")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's non-secret variables (values included).")
    .action(
      async (options: { environment?: string; org?: string; json?: boolean; token?: string }) => {
        const { runVariablesList } = await import("./commands/variables.js");
        await runVariablesList(options, { config: loadConfig() });
      },
    );

  variables
    .command("set")
    .argument("<name>", "variable name, e.g. POSTHOG_PROJECT_ID")
    .argument("<value>", "the non-secret value")
    .option("--environment <name>", "scope to this environment (default: org base)")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Set a non-secret variable. Needs `boardwalk login --scopes admin`.")
    .action(
      async (
        name: string,
        value: string,
        options: { environment?: string; org?: string; token?: string },
      ) => {
        const { runVariableSet } = await import("./commands/variables.js");
        await runVariableSet({ name, value, ...options }, { config: loadConfig() });
      },
    );

  variables
    .command("delete")
    .argument("<name>", "variable name")
    .option("--environment <name>", "scope to this environment (default: org base)")
    .option("--yes", "actually delete — without it, prints the target and exits", false)
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Delete a non-secret variable. Needs `boardwalk login --scopes admin`.")
    .action(
      async (
        name: string,
        options: { environment?: string; yes?: boolean; org?: string; token?: string },
      ) => {
        const { runVariableDelete } = await import("./commands/variables.js");
        await runVariableDelete({ name, ...options }, { config: loadConfig() });
      },
    );
}

/** Register `inference` + its `list` / `add` / `delete` subcommands (writes need `login --scopes admin`). */
function registerInferenceCommand(program: Command): void {
  const inference = program
    .command("inference")
    .description("Manage the org's BYO inference providers (list, add, delete).");

  inference
    .command("list", { isDefault: true })
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the org's inference providers (endpoints only — never API keys).")
    .action(async (options: { org?: string; json?: boolean; token?: string }) => {
      const { runInferenceList } = await import("./commands/inference.js");
      await runInferenceList(options, { config: loadConfig() });
    });

  inference
    .command("add")
    .argument("<name>", "provider name (referenced as agent({ provider }))")
    .requiredOption(
      "--source <source>",
      "bedrock | anthropic | google | openai | openai_compatible | azure_openai",
    )
    .option("--base-url <url>", "endpoint base URL (openai_compatible / azure)")
    .option("--region <region>", "region (bedrock)")
    .option("--api-version <v>", "API version (azure_openai)")
    .option("--api-key <key>", "provider API key (prefer piping via stdin)")
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Register a BYO inference provider. Needs `boardwalk login --scopes admin`.")
    .action(
      async (
        name: string,
        options: {
          source?: string;
          baseUrl?: string;
          region?: string;
          apiVersion?: string;
          apiKey?: string;
          org?: string;
          token?: string;
        },
      ) => {
        const { runInferenceAdd } = await import("./commands/inference.js");
        await runInferenceAdd({ name, ...options }, { config: loadConfig() });
      },
    );

  inference
    .command("delete")
    .argument("<name>", "provider name")
    .option("--yes", "actually delete — without it, prints the target and exits", false)
    .option("--org <slug>", "the org (optional once the project is linked)")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description(
      "Delete an inference provider (irreversible). Needs `boardwalk login --scopes admin`.",
    )
    .action(async (name: string, options: { yes?: boolean; org?: string; token?: string }) => {
      const { runInferenceDelete } = await import("./commands/inference.js");
      await runInferenceDelete({ name, ...options }, { config: loadConfig() });
    });
}

/** Register `models` + its `list` / `show` subcommands — read-only browse of the managed-lane catalog. */
function registerModelsCommand(program: Command): void {
  const models = program
    .command("models")
    .description("Browse the managed-lane model catalog for agent() calls (list, show).");

  models
    .command("list", { isDefault: true })
    .option("--all", "show every model (default: the most-capable head)", false)
    .option("--search <query>", "filter by id or display name (case-insensitive)")
    .option("--json", "print the raw catalog as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List the models an agent() call can run on the managed lane, with prices.")
    .action(async (options: { all?: boolean; search?: string; json?: boolean; token?: string }) => {
      const { runModelsList } = await import("./commands/models.js");
      await runModelsList(options, { config: loadConfig() });
    });

  models
    .command("show")
    .argument("<id>", "model id, e.g. anthropic/claude-opus-4.8")
    .option("--json", "print the raw model record as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description(
      "Show one model's price, context window, and whether the managed lane supports it.",
    )
    .action(async (id: string, options: { json?: boolean; token?: string }) => {
      const { runModelsShow } = await import("./commands/models.js");
      await runModelsShow({ id, ...options }, { config: loadConfig() });
    });
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } finally {
    // After the command runs, nudge if the server advertised a newer/min CLI version. Silent when
    // no API call was made (seen === undefined) or we nudged in the last 24h. To stderr, so it never
    // corrupts a `--json` stdout payload. Guarded — a nudge must never change the command's outcome.
    try {
      const { maybePrintVersionNudge } = await import("./version_nudge.js");
      maybePrintVersionNudge({
        configDir: loadConfig().configDir,
        currentVersion: VERSION,
        moduleUrl: import.meta.url,
      });
    } catch {
      // ignore
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    if (err.hint !== undefined) console.error(`  ${err.hint}`);
    process.exitCode = err.exitCode ?? 1;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
