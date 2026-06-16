// SPDX-License-Identifier: MIT

// boardwalk CLI entrypoint — argument parsing + command dispatch (commander).
//
// Commands:
//   boardwalk init [dir]                Scaffold a new workflow project from a template.
//   boardwalk dev <file>                Run the workflow now, locally (no account needed).
//   boardwalk check <file>              Validate a workflow locally (no auth/network).
//   boardwalk login                     Authenticate via browser (OAuth PKCE).
//   boardwalk logout                    Remove local credentials.
//   boardwalk whoami                    Show the current session (quick, local).
//   boardwalk status                    Show host, login (live-verified), and project link.
//   boardwalk deploy <file> --org <s>   Create/update a workflow from a program file.
//   boardwalk run <file> --org <s>      Deploy + trigger a real run, wait for the result.
//   boardwalk cancel <runId>            Cancel a queued or in-flight run.
//   boardwalk usage --org <s>           Show org usage: runs, compute, tokens, credit, cache.
//   boardwalk runs [runId] --org <s>    List recent runs, or show one run's detail.
//
// Auth precedence for deploy/run/cancel/usage: --token > BOARDWALK_API_KEY env > stored `login`.
//
// Every command body is lazy-imported inside its action — `boardwalk --help` must stay fast, so
// nothing heavy (esbuild, the SDK extractor, the API client) loads until its command actually runs.

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { CliError } from "./errors.js";
import { loadConfig } from "./config.js";

// Read the version from package.json (one level up from both src/ and dist/) so `--version`
// can never drift from the published package. Cheap sync read at load — doesn't touch the
// lazy-import budget that keeps `--help` fast.
function readVersion(): string {
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
  token?: string;
  wait?: boolean;
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
      const { runDev } = await import("./commands/dev.js");
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
    .action(async (options: { token?: string }) => {
      const { runLogin } = await import("./commands/session.js");
      await runLogin({ config: loadConfig() }, { token: options.token });
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
    .description("Show the current session.")
    .action(async () => {
      const { runWhoami } = await import("./commands/session.js");
      runWhoami({ config: loadConfig() });
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
    .option("--no-wait", "trigger and exit without waiting for the run to finish")
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("Deploy the program, trigger a real run, and wait for the result.")
    .action(async (file: string, options: RunCliOptions) => {
      const { runRun } = await import("./commands/run.js");
      await runRun(
        {
          file,
          org: options.org,
          input: options.input,
          noWait: options.wait === false,
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
    .argument("[runId]", "show this run's detail instead of the list (no --org needed)")
    .option("--org <slug>", "the org to list runs for (optional once the project is linked)")
    .option("--status <status>", "filter by status (e.g. running, completed, failed, cancelled)")
    .option("--limit <n>", "how many runs to show (server-clamped)")
    .option("--json", "print the raw response as JSON", false)
    .option("--token <token>", "use this Bearer token instead of stored/env credentials")
    .description("List your org's recent runs, or show one run's detail with `runs <runId>`.")
    .action(
      async (
        runId: string | undefined,
        options: {
          org?: string;
          status?: string;
          limit?: string;
          json?: boolean;
          token?: string;
        },
      ) => {
        const { runRuns } = await import("./commands/runs.js");
        await runRuns(
          {
            runId,
            org: options.org,
            status: options.status,
            limit: options.limit,
            json: options.json,
            token: options.token,
          },
          { config: loadConfig() },
        );
      },
    );

  return program;
}

async function main(): Promise<void> {
  await buildProgram().parseAsync(process.argv);
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
