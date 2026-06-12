// `boardwalk dev <file|dir>` — run the workflow NOW, locally, no account.
//
// The tightest possible author loop: derive + validate the manifest (precise errors before
// anything runs), bundle the program, execute it in-process against the minimal dev host
// (secrets from .env, real sleeps, Phase/output events), and stream the run-event log through
// the channel-filtered renderer — the same flags and frames every engine speaks.
//
// Exit codes: 0 completed · 1 failed · 130 cancelled (Ctrl-C).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import {
  installConfig,
  installHost,
  installInput,
  resetRuntime,
  takeDeclaredOutput,
} from "@boardwalk/workflow/runtime";
import { CliError } from "../errors.js";
import { bundleForDev, resolveEntry } from "../bundle.js";
import { extractValidatedManifest } from "../manifest.js";
import { projectDirFor } from "../project.js";
import { createDevHost, type RunEventBody } from "../dev/host.js";
import { createRenderer, parseChannels } from "../render/renderer.js";
import { parseInput } from "./run.js";

export interface DevOptions {
  file: string;
  input?: string | undefined;
  envFile?: string | undefined;
  verbose: boolean;
  stream?: string | undefined;
}

export interface DevDeps {
  /** Raw event-stream writer (defaults to process.stdout). */
  write?: (text: string) => void;
  /** SIGINT hook installer — injected so tests don't touch real process signals. */
  onSigint?: (handler: () => void) => () => void;
}

export async function runDev(opts: DevOptions, deps: DevDeps = {}): Promise<void> {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });

  const channels = parseChannels({ verbose: opts.verbose, stream: opts.stream });
  const renderer = createRenderer(channels, write);

  // 1. Validate before anything runs — errors point at the author's real file.
  const entry = resolveEntry(opts.file);
  const manifest = extractValidatedManifest(readFileSync(entry, "utf8"), entry);
  const input = parseInput(opts.input);

  // 2. The local secret store: the project's env file (explicit --env-file must exist).
  const projectDir = projectDirFor(opts.file);
  const envPath = opts.envFile ?? join(projectDir, ".env");
  const envVars = loadEnvFile(envPath, opts.envFile !== undefined);

  // 3. The run-event emitter: a single dev turn, 1-based seq, rendered through the channel filter.
  const runId = `dev-${Date.now().toString(36)}`;
  let seq = 0;
  const emit = (body: RunEventBody): void => {
    seq += 1;
    renderer.render({ ...body, runId, turnId: runId, seq, t: Date.now() });
  };

  // 4. Install the host + run inputs, bundle, and execute the program in-process.
  const runsDir = join(projectDir, ".bw-runs", runId);
  resetRuntime();
  installHost(
    createDevHost({
      manifest,
      envVars,
      envLabel: envPath,
      artifactsDir: join(runsDir, "artifacts"),
      emit,
    }),
  );
  installInput(input);
  installConfig({});

  const staging = mkdtempSync(join(tmpdir(), "bw-dev-"));
  const restoreSigint = (deps.onSigint ?? defaultOnSigint)(() => {
    emit({ kind: "run_status", status: "cancelled" });
    process.exit(130);
  });
  try {
    const bundlePath = join(staging, "index.mjs");
    writeFileSync(bundlePath, await bundleForDev(entry), "utf8");

    emit({ kind: "run_status", status: "running" });

    // A workflow program is a SCRIPT: importing the module IS running it (top-level body +
    // top-level awaits). The import settles when the run completes; a top-level throw rejects it.
    let mod: { default?: unknown };
    try {
      mod = (await import(pathToFileURL(bundlePath).href)) as { default?: unknown };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        kind: "run_status",
        status: "failed",
        error: { code: "PROGRAM_ERROR", message },
      });
      const hint = err instanceof CliError ? err.hint : undefined;
      throw new CliError(`Run failed: ${message}`, hint, undefined, 1);
    }

    if (typeof mod.default === "function") {
      console.error(
        "warning: the program has a default export, which Boardwalk does not call — a workflow " +
          "runs top-to-bottom as a script. Move the body to the top level (top-level await is fine).",
      );
    }

    const declared = takeDeclaredOutput();
    if (declared !== null) emit({ kind: "output", value: declared.value });
    emit({ kind: "run_status", status: "completed" });
  } finally {
    restoreSigint();
    resetRuntime();
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Parse the env file into a map. A missing file is only an error when it was named explicitly. */
function loadEnvFile(path: string, explicit: boolean): ReadonlyMap<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    if (explicit) {
      throw new CliError(`Env file not found: ${path}`);
    }
    return new Map();
  }
  const parsed = parseEnv(raw);
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") out.set(key, value);
  }
  return out;
}

function defaultOnSigint(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return (): void => {
    process.removeListener("SIGINT", handler);
  };
}
