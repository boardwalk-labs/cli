import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDev } from "./dev.js";

const noSigint = (_handler: () => void): (() => void) => {
  return () => undefined;
};

describe("runDev (end-to-end, in-process)", () => {
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

  it("runs a workflow to completion: input → secrets → Phase → output, exit clean", async () => {
    writeFileSync(join(dir, ".env"), "GREETING_PREFIX=Hey\n");
    const file = join(dir, "index.ts");
    writeFileSync(
      file,
      `import { Phase, input, output, secrets, type WorkflowMeta } from "@boardwalk/workflow";
       export const meta = {
         name: "greet",
         triggers: [{ kind: "manual" }],
         secrets: [{ name: "GREETING_PREFIX" }],
       } satisfies WorkflowMeta;
       export default async function run(): Promise<void> {
         Phase("Greet");
         const prefix = await secrets.get("GREETING_PREFIX");
         output(\`\${prefix}, \${String(input)}!\`);
       }`,
    );

    await runDev(
      { file, input: '"Ada"', verbose: false, stream: undefined, envFile: undefined },
      { write, onSigint: noSigint },
    );

    expect(out).toContain("● run running");
    expect(out).toContain("▸ Greet");
    expect(out).toContain("Hey, Ada!");
    expect(out).toContain("● run completed");
    // The secret VALUE appears only inside the declared output here; assert it never leaked
    // through a lifecycle/error line.
    expect(out).not.toContain("GREETING_PREFIX=");
  });

  it("fails the run (and reports it on the stream) when the program throws", async () => {
    const file = join(dir, "boom.ts");
    writeFileSync(
      file,
      `export const meta = { name: "boom", triggers: [{ kind: "manual" }] };
       export default async function run(): Promise<void> {
         throw new Error("kapow");
       }`,
    );

    await expect(
      runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/kapow/);
    expect(out).toContain("● run failed");
    expect(out).toContain("PROGRAM_ERROR: kapow");
  });

  it("rejects an invalid manifest before running anything", async () => {
    const file = join(dir, "invalid.ts");
    writeFileSync(file, `export const meta = { name: "x" }; export default async () => {};`);

    await expect(
      runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/triggers/);
    expect(out).not.toContain("● run running");
  });

  it("errors when the program has no default export", async () => {
    const file = join(dir, "nodefault.ts");
    writeFileSync(file, `export const meta = { name: "n", triggers: [{ kind: "manual" }] };`);

    await expect(
      runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/export default/);
  });

  it("errors on a missing explicit --env-file", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(
      file,
      `export const meta = { name: "e", triggers: [{ kind: "manual" }] };
       export default async function run(): Promise<void> {}`,
    );

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

  it("--stream output prints just the result (pipe-friendly)", async () => {
    const file = join(dir, "index.ts");
    writeFileSync(
      file,
      `import { output } from "@boardwalk/workflow";
       export const meta = { name: "pipe", triggers: [{ kind: "manual" }] };
       export default async function run(): Promise<void> {
         output({ answer: 42 });
       }`,
    );

    await runDev(
      { file, input: undefined, verbose: false, stream: "output", envFile: undefined },
      { write, onSigint: noSigint },
    );
    expect(JSON.parse(out)).toEqual({ answer: 42 });
  });

  it("a workflow using agent() fails with the engine pointer", async () => {
    const file = join(dir, "agentic.ts");
    writeFileSync(
      file,
      `import { agent } from "@boardwalk/workflow";
       export const meta = { name: "a", triggers: [{ kind: "manual" }] };
       export default async function run(): Promise<void> {
         await agent("hi");
       }`,
    );

    await expect(
      runDev(
        { file, input: undefined, verbose: false, stream: undefined, envFile: undefined },
        { write, onSigint: noSigint },
      ),
    ).rejects.toThrow(/agent\(\) isn't available in `boardwalk dev` yet/);
  });
});
