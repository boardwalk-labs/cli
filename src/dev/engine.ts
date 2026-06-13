// The engine seam for `boardwalk dev`.
//
// `dev` delegates a one-off local run to @boardwalk-labs/engine in EMBEDDED mode: construct →
// deploy → start → stream events → wait → close. The engine owns everything that makes a real
// run real — spawning the run process, the agent() loop, workflows.call, secret resolution from
// env, hold-and-pay sleep, crash-restart — so `dev` matches the server and hosted engines by
// construction (parity), instead of re-implementing a thinner host.
//
// The real Engine is wrapped behind a tiny interface so tests can drive dev's orchestration
// (event rendering, exit codes, Ctrl-C cancel) with a fake, without spawning real processes.

import { Engine } from "@boardwalk-labs/engine";
import type { RunErrorShape, RunStatus } from "@boardwalk-labs/engine";
import type { JsonValue, RunEvent } from "@boardwalk-labs/workflow";

/** The terminal outcome `dev` needs from a run. */
export interface DevRunResult {
  status: RunStatus;
  output: JsonValue | null;
  error: RunErrorShape | null;
}

/** The slice of the engine facade `boardwalk dev` drives. The real {@link Engine} satisfies it. */
export interface DevEngine {
  /** Subscribe to the run's stamped events (the envelope is already applied). */
  onEvent(listener: (event: RunEvent) => void): () => void;
  /** Deploy the bundled program; returns the derived workflow name. */
  deploy(program: string): { name: string };
  /** Queue + dispatch a run; returns its id immediately. */
  start(workflowName: string, input: JsonValue | undefined): { id: string };
  /** Resolve when the run reaches a terminal status. */
  wait(runId: string): Promise<DevRunResult>;
  /** Cooperatively cancel a run (Ctrl-C). */
  cancel(runId: string): Promise<void>;
  /** Release the engine (DB + any held processes). */
  close(): void;
}

export interface DevEngineOptions {
  /** Throwaway per-invocation data dir (SQLite + run dirs live here; removed after the run). */
  dataDir: string;
  /** The local secret/env source (parsed .env). The engine falls back to process.env. */
  env: Record<string, string>;
  /** Where secrets come from, for the engine's error hints — never their values. */
  envLabel: string;
}

export type DevEngineFactory = (opts: DevEngineOptions) => DevEngine;

/** Production factory: the real single-node engine in embedded mode. */
export const createDevEngine: DevEngineFactory = (opts) => {
  const engine = new Engine({
    dataDir: opts.dataDir,
    env: opts.env,
    envLabel: opts.envLabel,
  });
  return {
    onEvent: (listener) =>
      engine.onEvent((row) => {
        listener(row.event);
      }),
    deploy: (program) => {
      const workflow = engine.deployWorkflow({ program });
      return { name: workflow.name };
    },
    start: (workflowName, input) => {
      const run = engine.startRun(workflowName, input !== undefined ? { input } : {});
      return { id: run.id };
    },
    wait: async (runId) => {
      const row = await engine.waitForRun(runId);
      return { status: row.status, output: row.output, error: row.error };
    },
    cancel: (runId) => engine.cancelRun(runId),
    close: () => {
      engine.close();
    },
  };
};
