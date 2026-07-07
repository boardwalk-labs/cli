// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  runRunnerList,
  runRunnerPoolToken,
  runRunnerRemove,
  runRunnerStart,
  runRunnerRegister,
} from "./runner.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";
import { loadIdentity, saveIdentity } from "@boardwalk-labs/runner/daemon";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function routeFetch(handler: (url: string, method: string) => Response): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    return Promise.resolve(handler(url, method));
  }) as FetchLike;
  return { fetchImpl, calls };
}

const RUNNER_ROW = {
  id: "01H_runner",
  poolId: "01H_pool",
  name: "mbp",
  labels: ["gpu"],
  os: "macos",
  arch: "arm64",
  version: "0.1.2",
  status: "idle",
  lastSeenAt: 1_700_000_000_000,
  createdAt: 1_700_000_000_000,
};

async function tmpDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("runner list", () => {
  it("prints runners with pool names resolved", async () => {
    const { fetchImpl } = routeFetch((url) => {
      if (url.includes("/runner-pools")) {
        return new Response(JSON.stringify({ pools: [{ id: "01H_pool", name: "default" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ runners: [RUNNER_ROW] }), { status: 200 });
    });
    const lines: string[] = [];
    await runRunnerList(
      { org: "acme", token: "bwk_t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toContain("mbp");
    expect(out).toContain("pool=default");
    expect(out).toContain("idle");
  });
});

describe("runner remove", () => {
  it("requires --yes", async () => {
    const { fetchImpl, calls } = routeFetch(() => new Response(null, { status: 204 }));
    await expect(
      runRunnerRemove(
        { runnerId: "01H_runner", org: "acme", token: "bwk_t" },
        { config: CONFIG, fetchImpl },
      ),
    ).rejects.toThrow(/--yes/);
    expect(calls).toHaveLength(0);
  });

  it("deregisters with --yes", async () => {
    const { fetchImpl, calls } = routeFetch(() => new Response(null, { status: 204 }));
    await runRunnerRemove(
      { runnerId: "01H_runner", org: "acme", yes: true, token: "bwk_t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url).toContain("/v1/runners/01H_runner");
  });
});

describe("runner pools token", () => {
  it("mints and prints the register command", async () => {
    const { fetchImpl, calls } = routeFetch(
      () =>
        new Response(JSON.stringify({ registrationToken: "bwkreg_raw", expiresAt: 1 }), {
          status: 201,
        }),
    );
    const lines: string[] = [];
    await runRunnerPoolToken(
      { org: "acme", pool: "gpu", token: "bwk_t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls[0]?.url).toContain("/runner-pools/gpu/registration-tokens");
    const out = lines.join("\n");
    expect(out).toContain("bwkreg_raw");
    expect(out).toContain("boardwalk runner register");
  });
});

describe("runner start", () => {
  it("one-step registers, saves the identity, and starts the daemon", async () => {
    const identityDir = await tmpDir("bw-cli-runner-");
    const { fetchImpl, calls } = routeFetch(
      () =>
        new Response(
          JSON.stringify({ runner: { ...RUNNER_ROW, id: "01H_new" }, runnerToken: "bwkr_raw" }),
          { status: 201 },
        ),
    );
    const daemon = vi.fn().mockReturnValue({ done: Promise.resolve(), drain: () => undefined });
    await runRunnerStart(
      { org: "acme", pool: "default", name: "mbp", token: "bwk_t", once: true },
      {
        config: CONFIG,
        fetchImpl,
        log: () => undefined,
        identityDir,
        daemon: daemon as never,
        hostname: () => "mbp",
      },
    );
    // Registered through the MANAGEMENT API (one-step; no registration token in sight).
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toContain("/v1/orgs/acme/runners");
    // Identity persisted for restarts.
    const identity = await loadIdentity(identityDir, "https://api.x", "default");
    expect(identity?.runner_id).toBe("01H_new");
    expect(identity?.runner_token).toBe("bwkr_raw");
    // Daemon started with the standing credential + once mode.
    expect(daemon).toHaveBeenCalledTimes(1);
    const arg = daemon.mock.calls[0]?.[0] as { runnerId: string; once?: boolean };
    expect(arg.runnerId).toBe("01H_new");
    expect(arg.once).toBe(true);
  });

  it("reuses a saved identity without re-registering", async () => {
    const identityDir = await tmpDir("bw-cli-runner-");
    await saveIdentity(identityDir, {
      runner_id: "01H_saved",
      runner_token: "bwkr_saved",
      control_plane_url: "https://api.x",
      pool: "default",
      name: "mbp",
      created_at: 1,
    });
    const { fetchImpl, calls } = routeFetch(() => new Response("{}", { status: 200 }));
    const daemon = vi.fn().mockReturnValue({ done: Promise.resolve(), drain: () => undefined });
    await runRunnerStart(
      { org: "acme", token: "bwk_t" },
      { config: CONFIG, fetchImpl, log: () => undefined, identityDir, daemon: daemon as never },
    );
    expect(calls).toHaveLength(0); // no management-API call at all
    expect((daemon.mock.calls[0]?.[0] as { runnerId: string }).runnerId).toBe("01H_saved");
  });

  it("--debug turns on debug logging for daemon and children", async () => {
    const identityDir = await tmpDir("bw-cli-runner-");
    await saveIdentity(identityDir, {
      runner_id: "r",
      runner_token: "t",
      control_plane_url: "https://api.x",
      pool: "default",
      name: "m",
      created_at: 1,
    });
    delete process.env.BOARDWALK_RUNNER_DEBUG;
    delete process.env.BOARDWALK_RUNNER_LOG_LEVEL;
    const daemon = vi.fn().mockReturnValue({ done: Promise.resolve(), drain: () => undefined });
    await runRunnerStart(
      { org: "acme", token: "bwk_t", debug: true },
      {
        config: CONFIG,
        fetchImpl: routeFetch(() => new Response("{}")).fetchImpl,
        log: () => undefined,
        identityDir,
        daemon: daemon as never,
      },
    );
    expect(process.env.BOARDWALK_RUNNER_LOG_LEVEL).toBe("debug");
    expect(process.env.BOARDWALK_RUNNER_DEBUG).toBe("1");
    delete process.env.BOARDWALK_RUNNER_DEBUG;
    delete process.env.BOARDWALK_RUNNER_LOG_LEVEL;
  });
});

describe("runner register (two-step)", () => {
  it("redeems the token against the public endpoint and saves the identity", async () => {
    const identityDir = await tmpDir("bw-cli-runner-");
    const { fetchImpl, calls } = routeFetch(
      () =>
        new Response(
          JSON.stringify({
            runner_id: "01H_fleet",
            pool: "fleet",
            runner_token: "bwkr_fleet",
            poll: { url: "https://api.x/runner/v1/pool/poll", interval_seconds: 5 },
          }),
          { status: 201 },
        ),
    );
    const lines: string[] = [];
    await runRunnerRegister(
      { url: "https://api.x", registrationToken: "bwkreg_raw", name: "box-1" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), identityDir },
    );
    expect(calls[0]?.url).toBe("https://api.x/runner/v1/register");
    const identity = await loadIdentity(identityDir, "https://api.x", "fleet");
    expect(identity?.runner_token).toBe("bwkr_fleet");
    expect(lines.join("\n")).toContain("boardwalk runner start");
  });
});
