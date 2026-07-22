// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetup, type SetupDeps, type SetupOptions } from "./setup.js";
import type { CliConfig } from "../config.js";
import type { Prompter } from "../prompt.js";
import type { RunCommand, RunResult } from "../setup/spawn.js";
import type { DetectDeps } from "../setup/harness.js";

function mkConfig(configDir: string): CliConfig {
  return {
    apiBaseUrl: "https://api.boardwalk.sh",
    apiBaseExplicit: false,
    issuerUrl: "https://api.boardwalk.sh",
    oauthClientId: "boardwalk-cli",
    loopbackPort: 53682,
    configDir,
  };
}

/** A fetch that answers `GET /v1/me` as a logged-in account (everything else 404s). */
const meFetch: typeof fetch = (url) => {
  const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (new URL(href).pathname === "/v1/me") {
    return Promise.resolve(
      new Response(
        JSON.stringify({ user: { email: "dev@boardwalk.sh", name: null }, memberships: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }
  return Promise.resolve(new Response("no", { status: 404 }));
};

function detect(bins: string[], dirs: string[] = []): DetectDeps {
  return {
    commandExists: (bin) => Promise.resolve(bins.includes(bin)),
    dirExists: (p) => dirs.some((d) => p.endsWith(d)),
    homeDir: "/home/u",
  };
}

/** A runCommand spy: records every call and returns a code from `codeFor` (default 0). */
function recordingRun(codeFor: (cmd: string, args: string[]) => number = () => 0): {
  run: RunCommand;
  calls: { cmd: string; args: string[] }[];
} {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: RunCommand = (cmd, args): Promise<RunResult> => {
    calls.push({ cmd, args });
    return Promise.resolve({ code: codeFor(cmd, args), stdout: "", stderr: "" });
  };
  return { run, calls };
}

const yesPrompter: Prompter = {
  confirm: () => Promise.resolve(true),
  select: (_q, choices) => {
    const first = choices[0];
    if (first === undefined) throw new Error("no choices");
    return Promise.resolve(first.value);
  },
  multiselect: (_q, choices) => Promise.resolve(choices.map((c) => c.value)),
};

describe("runSetup", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-setup-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function harness(opts: SetupOptions, over: Partial<SetupDeps> = {}) {
    const lines: string[] = [];
    const deps: SetupDeps = {
      config: mkConfig(dir),
      log: (l) => lines.push(l),
      env: {},
      isTty: false,
      ...over,
    };
    return { run: () => runSetup(opts, deps), lines };
  }

  it("--print-only prints the plan and runs no installer", async () => {
    const spy = recordingRun();
    const { run, lines } = harness(
      { harness: "claude-code", printOnly: true },
      { runCommand: spy.run },
    );
    await run();
    expect(spy.calls.length).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("$ claude plugin marketplace add boardwalk-labs/plugins");
    expect(text).toContain("$ claude plugin install boardwalk@boardwalk-labs");
  });

  it("installs a detected single harness after a confirm", async () => {
    const spy = recordingRun();
    let loginCalls = 0;
    const { run, lines } = harness(
      {},
      {
        env: { BOARDWALK_API_KEY: "bwk_test" },
        fetchImpl: meFetch,
        isTty: true,
        detect: detect(["claude"]),
        prompter: yesPrompter,
        runCommand: spy.run,
        loginImpl: () => {
          loginCalls += 1;
          return Promise.resolve();
        },
      },
    );
    await run();
    expect(loginCalls).toBe(0); // already logged in via env key
    expect(lines.join("\n")).toContain("logged in as dev@boardwalk.sh");
    expect(spy.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`)).toEqual([
      "claude plugin marketplace add boardwalk-labs/plugins",
      "claude plugin install boardwalk@boardwalk-labs",
    ]);
  });

  it("sets exit code 1 when an install step fails", async () => {
    const spy = recordingRun((_cmd, args) => (args.includes("install") ? 1 : 0));
    let exit = 0;
    const { run, lines } = harness(
      { harness: "claude-code", yes: true, skipLogin: true },
      { runCommand: spy.run, setExitCode: (c) => (exit = c) },
    );
    await run();
    expect(exit).toBe(1);
    expect(lines.join("\n")).toContain("✗ exited 1");
  });

  it("rejects an unknown --harness id", async () => {
    const { run } = harness({ harness: "bogus", yes: true, skipLogin: true });
    await expect(run()).rejects.toThrow(/Unknown agent id/);
  });

  it("degrades a non-TTY run (no --yes/--harness) to a dry run", async () => {
    const spy = recordingRun();
    const { run, lines } = harness(
      {},
      { isTty: false, detect: detect(["claude"]), runCommand: spy.run },
    );
    await run();
    expect(spy.calls.length).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("dry run");
    expect(text).toContain("detected: Claude Code");
    expect(text).toContain("$ claude plugin install boardwalk@boardwalk-labs");
  });

  it("runs the browser login when interactive and not authenticated", async () => {
    const spy = recordingRun();
    let loginCalls = 0;
    const { run } = harness(
      {},
      {
        isTty: true,
        detect: detect(["codex"]),
        prompter: yesPrompter,
        runCommand: spy.run,
        loginImpl: () => {
          loginCalls += 1;
          return Promise.resolve();
        },
      },
    );
    await run();
    expect(loginCalls).toBe(1);
    expect(spy.calls[0]).toEqual({
      cmd: "npx",
      args: ["-y", "codex-plugin", "add", "boardwalk-labs/plugins"],
    });
  });

  it("prints the API-key MCP guidance when BOARDWALK_API_KEY is absent", async () => {
    const { run, lines } = harness(
      { harness: "claude-code", printOnly: true, skipLogin: true },
      { env: {} },
    );
    await run();
    const text = lines.join("\n");
    expect(text).toContain("app.boardwalk.sh/settings/api-keys");
    expect(text).toContain("export BOARDWALK_API_KEY=bwk_…");
  });
});
