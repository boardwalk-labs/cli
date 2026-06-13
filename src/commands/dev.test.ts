// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDev, type DevDeps } from "./dev.js";
import type { DevEngine, DevEngineFactory, DevRunResult } from "../dev/engine.js";
import { CliError } from "../errors.js";

const noSigint = (_handler: () => void): (() => void) => {
  return () => undefined;
};

// These run a real workflow file end-to-end through @boardwalk-labs/engine (spawned run process),
// so they prove parity, not just orchestration. Generous timeout: a real run forks Node.
const RUN = 30_000;

describe("runDev (end-to-end via the engine)", () => {
  let dir: string;
  let out: string;
  const write = (text: string): void => {
    out += text;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-dev-test-"));
    out = "";
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "runs a script-style workflow to completion: input → secrets → phase → output",
    async () => {
      writeFileSync(join(dir, ".env"), "GREETING_PREFIX=Hey\n");
      const file = join(dir, "index.ts");
      writeFileSync(
        file,
        `import { phase, input, output, secrets, type WorkflowMeta } from "@boardwalk-labs/workflow";
         export const meta = {
           name: "greet",
           triggers: [{ kind: "manual" }],
           secrets: [{ name: "GREETING_PREFIX" }],
         } satisfies WorkflowMeta;

         phase("Greet");
         const prefix = await secrets.get("GREETING_PREFIX");
         output(\`\${prefix}, \${String(input)}!\`);`,
      );

      await runDev(
        { file, input: '"Ada"', verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      );

      expect(out).toContain("● workflow running");
      expect(out).toContain("▸ Greet");
      expect(out).toContain("Hey, Ada!");
      expect(out).toContain("● workflow completed");
      // The secret VALUE appears only inside the declared output; assert it never leaked through a
      // lifecycle/error line (and the env var name/line never surfaces).
      expect(out).not.toContain("GREETING_PREFIX=");
    },
    RUN,
  );

  it(
    "fails the run (and reports it on the stream) when the top-level body throws",
    async () => {
      const file = join(dir, "boom.ts");
      writeFileSync(
        file,
        `export const meta = { name: "boom", triggers: [{ kind: "manual" }] };
         throw new Error("kapow");`,
      );

      await expect(
        runDev(
          { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
          { write, onSigint: noSigint },
        ),
      ).rejects.toThrow(/kapow/);
      expect(out).toContain("● workflow failed");
      expect(out).toContain("PROGRAM_ERROR: kapow");
    },
    RUN,
  );

  it(
    "preserves output declared before a failure (verdict-then-throw)",
    async () => {
      const file = join(dir, "verdict.ts");
      writeFileSync(
        file,
        `import { output } from "@boardwalk-labs/workflow";
         export const meta = { name: "v", triggers: [{ kind: "manual" }] };
         output({ healthy: false });
         throw new Error("deadline passed");`,
      );

      await expect(
        runDev(
          { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
          { write, onSigint: noSigint },
        ),
      ).rejects.toThrow(/deadline passed/);
      expect(out).toContain('"healthy": false');
      expect(out).toContain("● workflow failed");
    },
    RUN,
  );

  it(
    "a do-nothing script completes (no entrypoint convention to satisfy)",
    async () => {
      const file = join(dir, "noop.ts");
      writeFileSync(file, `export const meta = { name: "n", triggers: [{ kind: "manual" }] };`);

      await runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      );
      expect(out).toContain("● workflow completed");
    },
    RUN,
  );

  it(
    "a legacy default export is never called; the run still completes",
    async () => {
      const file = join(dir, "legacy.ts");
      writeFileSync(
        file,
        `import { output } from "@boardwalk-labs/workflow";
         export const meta = { name: "legacy", triggers: [{ kind: "manual" }] };
         export default async function run(): Promise<void> {
           output("from the wrapper — must NOT appear");
         }`,
      );

      await runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      );
      expect(out).toContain("● workflow completed");
      // The module body is the program; the default export is dead code (the engine warns in the
      // run log). It must never run, so its output must never appear.
      expect(out).not.toContain("from the wrapper");
    },
    RUN,
  );

  it(
    "--stream output prints just the result (pipe-friendly)",
    async () => {
      const file = join(dir, "index.ts");
      writeFileSync(
        file,
        `import { output } from "@boardwalk-labs/workflow";
         export const meta = { name: "pipe", triggers: [{ kind: "manual" }] };
         output({ answer: 42 });`,
      );

      await runDev(
        { file, input: undefined, verbose: false, stream: "output", envFile: undefined },
        { write, onSigint: noSigint },
      );
      expect(JSON.parse(out)).toEqual({ answer: 42 });
    },
    RUN,
  );

  it(
    "agent() reaches the engine (no longer a dev stub): unresolved inference fails the run",
    async () => {
      const file = join(dir, "agentic.ts");
      writeFileSync(
        file,
        `import { agent } from "@boardwalk-labs/workflow";
         export const meta = { name: "a", triggers: [{ kind: "manual" }] };
         await agent("hi", { provider: "no-such-provider" });`,
      );

      // Naming an unconfigured provider fails deterministically at model resolution — proving the
      // call went INTO the engine's agent leaf, not the old "agent() isn't available" stub.
      await expect(
        runDev(
          { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
          { write, onSigint: noSigint },
        ),
      ).rejects.toThrow(/no-such-provider/);
      expect(out).toContain("● workflow failed");
      expect(out).not.toContain("isn't available");
    },
    RUN,
  );

  it("rejects an invalid manifest before running anything", async () => {
    const file = join(dir, "invalid.ts");
    writeFileSync(file, `export const meta = { name: "x" };\nconsole.log("never runs");`);

    await expect(
      runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/triggers/);
    expect(out).not.toContain("● workflow running");
  });

  it("errors on a missing explicit --env file", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, `export const meta = { name: "e", triggers: [{ kind: "manual" }] };`);

    await expect(
      runDev(
        {
          file,
          input: undefined,
          verbose: false,
          stream: undefined,
          envFile: join(dir, "nope.env"),
        },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/Env file not found/);
  });

  it("Ctrl-C cancels the run and exits 130", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(file, `export const meta = { name: "c", triggers: [{ kind: "manual" }] };`);

    // A fake engine whose run never finishes on its own — only a cancel() resolves it. The injected
    // SIGINT hook fires once the run has started (mid-wait), exercising the cooperative-cancel path
    // deterministically (no real signals, no process spawn).
    let resolveWait: (r: DevRunResult) => void = () => undefined;
    let sigint: (() => void) | null = null;
    const fakeEngine: DevEngine = {
      onEvent: () => () => undefined,
      deploy: () => ({ name: "c" }),
      start: () => ({ id: "run-1" }),
      wait: () =>
        new Promise<DevRunResult>((resolve) => {
          resolveWait = resolve;
          setImmediate(() => sigint?.()); // Ctrl-C arrives mid-run
        }),
      cancel: () => {
        resolveWait({ status: "cancelled", output: null, error: null });
        return Promise.resolve();
      },
      close: () => undefined,
    };
    const createEngine: DevEngineFactory = () => fakeEngine;
    const onSigint = (handler: () => void): (() => void) => {
      sigint = handler;
      return () => undefined;
    };

    const err = await runDev(
      { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
      { write, onSigint, createEngine },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    if (err instanceof CliError) {
      expect(err.exitCode).toBe(130);
    }
  });

  it("merges the managed-inference overlay into the engine env and threads --org through", async () => {
    writeFileSync(join(dir, ".env"), "FOO=bar\n");
    const file = join(dir, "index.ts");
    writeFileSync(file, `export const meta = { name: "i", triggers: [{ kind: "manual" }] };`);

    let captured: Record<string, string> = {};
    let seenOrg: string | null = "unset";
    const fakeEngine: DevEngine = {
      onEvent: () => () => undefined,
      deploy: () => ({ name: "i" }),
      start: () => ({ id: "run-1" }),
      wait: () => Promise.resolve<DevRunResult>({ status: "completed", output: null, error: null }),
      cancel: () => Promise.resolve(),
      close: () => undefined,
    };
    const createEngine: DevEngineFactory = (o) => {
      captured = o.env;
      return fakeEngine;
    };
    const resolveInference: NonNullable<DevDeps["resolveInference"]> = (d) => {
      seenOrg = d.orgSlug;
      return Promise.resolve({
        BOARDWALK_API_KEY: "bwk_x",
        BOARDWALK_INFERENCE_URL: "https://api/v1/inference",
      });
    };

    await runDev(
      {
        file,
        input: undefined,
        verbose: false,
        stream: undefined,
        envFile: undefined,
        org: "acme",
      },
      { write, onSigint: noSigint, createEngine, resolveInference },
    );

    expect(captured.FOO).toBe("bar"); // the .env still flows through
    expect(captured.BOARDWALK_API_KEY).toBe("bwk_x"); // overlay merged in
    expect(captured.BOARDWALK_INFERENCE_URL).toBe("https://api/v1/inference");
    expect(seenOrg).toBe("acme"); // --org reached the resolver
  });
});
