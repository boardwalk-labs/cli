// The `boardwalk dev` WorkflowHost — the minimal embedded host backing a one-off local run.
//
// Scope (v0.1, until `@boardwalk/engine` ships and `dev` delegates to its embedded mode):
//   - secrets resolve from the project's env file (fail-closed against `meta.secrets`)
//   - sleep really sleeps (hold-and-pay semantics: locals survive, the process waits)
//   - Phase() markers and output() flow into the run-event stream
//   - artifacts write under `.bw-runs/<runId>/artifacts/`
//   - agent() and workflows.call() fail with a clear pointer at what supports them
//
// Secret VALUES never reach the event stream or any error message.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ArtifactBody,
  ArtifactRef,
  PhaseOptions,
  SleepArg,
  WorkflowManifest,
} from "@boardwalk/workflow";
import type { WorkflowHost } from "@boardwalk/workflow/runtime";
import type { RunEvent } from "@boardwalk/workflow";
import { CliError } from "../errors.js";

/** A run event minus its envelope — the emitter (dev.ts) stamps runId/turnId/seq/t. */
export type RunEventBody = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "runId" | "turnId" | "seq" | "t">
    : never
  : never;

export interface DevHostContext {
  manifest: WorkflowManifest;
  /** Parsed env file contents — the local secret store. */
  envVars: ReadonlyMap<string, string>;
  /** The env file path, for actionable error messages (never its contents). */
  envLabel: string;
  /** Directory artifacts are written under (created lazily). */
  artifactsDir: string;
  emit: (body: RunEventBody) => void;
}

export function createDevHost(ctx: DevHostContext): WorkflowHost {
  let phaseCount = 0;
  let artifactCount = 0;

  return {
    setPhase(name: string, opts: PhaseOptions | undefined): void {
      phaseCount += 1;
      ctx.emit({ kind: "phase", name, id: opts?.id ?? `phase-${String(phaseCount)}` });
    },

    agent(): Promise<unknown> {
      throw new CliError(
        "agent() isn't available in `boardwalk dev` yet.",
        "The embedded local engine ships with @boardwalk/engine — until then, deploy and use " +
          "`boardwalk run` to execute agent loops.",
      );
    },

    callWorkflow(): Promise<unknown> {
      throw new CliError(
        "workflows.call() isn't available in `boardwalk dev` — durable child runs need an engine.",
        "Deploy and use `boardwalk run`, or run the callee directly with `boardwalk dev <its file>`.",
      );
    },

    async sleep(arg: SleepArg): Promise<void> {
      const ms = sleepMs(arg);
      if (ms <= 0) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      });
    },

    getSecret(name: string): Promise<string> {
      const declared = (ctx.manifest.secrets ?? []).some((s) => s.name === name);
      if (!declared) {
        throw new CliError(
          `Secret "${name}" is not declared in meta.secrets.`,
          `Add { name: "${name}" } to meta.secrets — secret access is fail-closed everywhere.`,
        );
      }
      const value = ctx.envVars.get(name) ?? process.env[name];
      if (value === undefined || value.length === 0) {
        throw new CliError(
          `Secret "${name}" has no value for this local run.`,
          `Set ${name}=… in ${ctx.envLabel} (boardwalk dev resolves secrets from your env file).`,
        );
      }
      return Promise.resolve(value);
    },

    writeArtifact(
      name: string,
      _contentType: string,
      body: ArtifactBody,
      _metadata: Record<string, unknown> | undefined,
    ): Promise<ArtifactRef> {
      if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        throw new CliError(`Artifact name "${name}" must be a plain file name.`);
      }
      mkdirSync(ctx.artifactsDir, { recursive: true });
      const path = join(ctx.artifactsDir, name);
      writeFileSync(path, body);
      artifactCount += 1;
      return Promise.resolve({
        id: `art-${String(artifactCount)}`,
        name,
        url: pathToFileURL(path).href,
      });
    },
  };
}

function sleepMs(arg: SleepArg): number {
  if (typeof arg === "number") return arg;
  if ("durationMs" in arg) return arg.durationMs;
  const until = arg.until instanceof Date ? arg.until.getTime() : Date.parse(arg.until);
  if (Number.isNaN(until)) {
    throw new CliError(`sleep({ until }) got an unparseable date: ${String(arg.until)}`);
  }
  return until - Date.now();
}
