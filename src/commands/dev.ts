// `boardwalk dev <file|dir>` — run the workflow NOW, locally, no account.
//
// The tightest possible author loop: derive + validate the manifest (precise errors before
// anything runs), bundle the program, then hand the whole run to @boardwalk-labs/engine in
// embedded mode and stream its run-event log through the channel-filtered renderer — the same
// flags, frames, and run semantics (agent(), workflows.call, sleep, secrets) every engine speaks.
//
// Exit codes: 0 completed · 1 failed · 130 cancelled (Ctrl-C).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { JsonValue } from "@boardwalk-labs/workflow";
import { CliError } from "../errors.js";
import { bundleWorkflow, resolveEntry } from "../bundle.js";
import { extractValidatedManifest } from "../manifest.js";
import { projectDirFor } from "../project.js";
import { createDevEngine, type DevEngineFactory } from "../dev/engine.js";
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
  /** Engine factory — injected so tests can drive orchestration without spawning processes. */
  createEngine?: DevEngineFactory;
}

export async function runDev(opts: DevOptions, deps: DevDeps = {}): Promise<void> {
  const write =
    deps.write ??
    ((text: string): void => {
      process.stdout.write(text);
    });
  const createEngine = deps.createEngine ?? createDevEngine;

  const channels = parseChannels({ verbose: opts.verbose, stream: opts.stream });
  const renderer = createRenderer(channels, write);

  // 1. Validate before anything runs — errors point at the author's real file.
  const entry = resolveEntry(opts.file);
  extractValidatedManifest(readFileSync(entry, "utf8"), entry);
  const input = jsonInput(parseInput(opts.input));

  // 2. The local secret store: the project's env file (explicit --env must exist).
  const projectDir = projectDirFor(opts.file);
  const envPath = opts.envFile ?? join(projectDir, ".env");
  const envVars = loadEnvFile(envPath, opts.envFile !== undefined);

  // 3. Bundle the program — `@boardwalk-labs/workflow` left EXTERNAL; the engine resolves it from
  //    its own copy (one shared SDK instance, so the host seam works) when it runs the program.
  const program = await bundleWorkflow(entry);

  // 4. Run it on the embedded engine in a throwaway data dir; stream its events.
  const dataDir = mkdtempSync(join(tmpdir(), "bw-dev-"));
  const engine = createEngine({
    dataDir,
    env: Object.fromEntries(envVars),
    envLabel: envPath,
  });
  const unsubscribe = engine.onEvent((event) => {
    renderer.render(event);
  });

  // Ctrl-C cancels the run cooperatively; `wait` then resolves `cancelled` → exit 130.
  let runId: string | null = null;
  const restoreSigint = (deps.onSigint ?? defaultOnSigint)(() => {
    if (runId !== null) void engine.cancel(runId);
  });

  try {
    const workflow = engine.deploy(program);
    const run = engine.start(workflow.name, input);
    runId = run.id;
    const result = await engine.wait(run.id);

    if (result.status === "completed") return;
    if (result.status === "cancelled") {
      throw new CliError("Run cancelled.", undefined, undefined, 130);
    }
    const message = result.error?.message ?? "the run failed";
    throw new CliError(`Run failed: ${message}`, undefined, undefined, 1);
  } finally {
    unsubscribe();
    restoreSigint();
    engine.close();
    rmSync(dataDir, { recursive: true, force: true });
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

/** Narrow a `parseInput` result (always JSON.parse output, or undefined) to a JsonValue. */
function jsonInput(value: unknown): JsonValue | undefined {
  return value === undefined ? undefined : asJsonValue(value);
}

function asJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(asJsonValue);
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = asJsonValue(entry);
    }
    return out;
  }
  throw new CliError("--input must be JSON (no functions or undefined values).");
}

function defaultOnSigint(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return (): void => {
    process.removeListener("SIGINT", handler);
  };
}
