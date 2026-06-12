import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMeta } from "@boardwalk/workflow";
import { createDevHost, type RunEventBody } from "./host.js";

function makeCtx(over: { secrets?: { name: string }[]; env?: [string, string][] } = {}) {
  const events: RunEventBody[] = [];
  const dir = mkdtempSync(join(tmpdir(), "bw-devhost-"));
  const manifest = validateMeta({
    name: "t",
    triggers: [{ kind: "manual" }],
    ...(over.secrets !== undefined ? { secrets: over.secrets } : {}),
  });
  const host = createDevHost({
    manifest,
    envVars: new Map(over.env ?? []),
    envLabel: "/proj/.env",
    artifactsDir: join(dir, "artifacts"),
    emit: (e) => events.push(e),
  });
  return { host, events, dir };
}

describe("createDevHost", () => {
  let dirs: string[] = [];
  beforeEach(() => {
    dirs = [];
  });
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("resolves a declared secret from the env file map", async () => {
    const { host, dir } = makeCtx({
      secrets: [{ name: "API_KEY" }],
      env: [["API_KEY", "sk-test"]],
    });
    dirs.push(dir);
    await expect(host.getSecret("API_KEY")).resolves.toBe("sk-test");
  });

  it("fails closed on an undeclared secret — even when the env has it", async () => {
    const { host, dir } = makeCtx({ env: [["ROGUE", "v"]] });
    dirs.push(dir);
    await expect(async () => host.getSecret("ROGUE")).rejects.toThrow(/not declared/);
  });

  it("errors actionably (naming the env file, never the value) when a secret is unset", async () => {
    const { host, dir } = makeCtx({ secrets: [{ name: "API_KEY" }] });
    dirs.push(dir);
    await expect(async () => host.getSecret("API_KEY")).rejects.toMatchObject({
      hint: expect.stringContaining("/proj/.env"),
    });
  });

  it("emits phase events with assigned ids", () => {
    const { host, events, dir } = makeCtx();
    dirs.push(dir);
    host.setPhase?.("Fetch", undefined);
    host.setPhase?.("Summarize", { id: "sum" });
    expect(events).toEqual([
      { kind: "phase", name: "Fetch", id: "phase-1" },
      { kind: "phase", name: "Summarize", id: "sum" },
    ]);
  });

  it("agent() and workflows.call() fail with pointers, not silence", async () => {
    const { host, dir } = makeCtx();
    dirs.push(dir);
    await expect(async () => host.agent("hi", undefined)).rejects.toThrow(/boardwalk dev/);
    await expect(async () => host.callWorkflow("other", {}, undefined)).rejects.toThrow(/engine/);
  });

  it("writes artifacts under the run dir and returns a file URL", async () => {
    const { host, dir } = makeCtx();
    dirs.push(dir);
    const ref = await host.writeArtifact?.("report.txt", "text/plain", "hello", undefined);
    expect(ref?.url.startsWith("file://")).toBe(true);
    const path = join(dir, "artifacts", "report.txt");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  it("rejects artifact names that try to escape the run dir", async () => {
    const { host, dir } = makeCtx();
    dirs.push(dir);
    await expect(async () =>
      host.writeArtifact?.("../evil.txt", "text/plain", "x", undefined),
    ).rejects.toThrow(/plain file name/);
  });

  it("sleep(number) actually waits (and 0 returns immediately)", async () => {
    const { host, dir } = makeCtx();
    dirs.push(dir);
    const start = Date.now();
    await host.sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    await host.sleep(0); // no hang
  });

  it("sleep({ until }) accepts a past date as a no-op and rejects garbage", async () => {
    const { host, dir } = makeCtx();
    dirs.push(dir);
    await host.sleep({ until: new Date(Date.now() - 1000) });
    await expect(async () => host.sleep({ until: "not-a-date" })).rejects.toThrow(/unparseable/);
  });
});
