// SPDX-License-Identifier: MIT

// `boardwalk runner` — turn THIS machine into a self-hosted runner for your org
// (docs: self-hosted runners; the wire contract is @boardwalk-labs/runner):
//   • runner start           → one-step: register this machine (plain login, admin role) + go
//                              online in the pool, executing runs_on: { kind: "self-hosted" } runs
//   • runner register        → two-step fleet flow: redeem a registration token minted elsewhere
//   • runner list            → the org's runners (status, pool, labels, last seen)
//   • runner remove <id>     → deregister a runner (its credential dies with it)
//   • runner pools token     → mint a one-time registration token for a pool (fleet installs)
//
// `start` is the whole happy path: no elevated login, no token handling — the CLI registers via
// the management API (owner/admin membership required) and saves the standing runner identity at
// ~/.boardwalk/runner/, so restarts skip registration. Runs execute with THIS machine's network
// and toolchain; Ctrl-C drains (the current run finishes, nothing new is claimed).

import * as os from "node:os";
import * as path from "node:path";
import {
  PoolClient,
  defaultIdentityDir,
  loadIdentity,
  saveIdentity,
  startRunner,
  type IsolationConfig,
  type RunnerIdentity,
} from "@boardwalk-labs/runner/daemon";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { RunnerItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface RunnerDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Test seams. */
  identityDir?: string;
  /** The daemon runner (defaults to the package's shared startRunner). Injected in tests. */
  startRunner?: typeof startRunner;
  hostname?: () => string;
}

export interface RunnerStartOptions {
  org?: string | undefined;
  pool?: string | undefined;
  name?: string | undefined;
  labels?: string | undefined;
  once?: boolean | undefined;
  verbose?: boolean | undefined;
  debug?: boolean | undefined;
  workDir?: string | undefined;
  token?: string | undefined;
  /** Isolation: containerized by default; `--host` is the escape hatch. */
  host?: boolean | undefined;
  image?: string | undefined;
  network?: string | undefined;
  mount?: string | undefined;
}

export interface RunnerRegisterOptions {
  url: string;
  registrationToken: string;
  name?: string | undefined;
  labels?: string | undefined;
  pool?: string | undefined;
}

export interface RunnerListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface RunnerRemoveOptions {
  runnerId: string;
  org?: string | undefined;
  yes?: boolean | undefined;
  token?: string | undefined;
}

export interface RunnerPoolTokenOptions {
  org?: string | undefined;
  pool?: string | undefined;
  token?: string | undefined;
}

function applyLogFlags(opts: { verbose?: boolean | undefined; debug?: boolean | undefined }): void {
  // --verbose: debug-level daemon logs. --debug: the same, plus debug logging inside each
  // spawned run process (the env is forwarded to children by the spawner).
  if (opts.debug === true) {
    process.env.BOARDWALK_RUNNER_LOG_LEVEL = "debug";
    process.env.BOARDWALK_RUNNER_DEBUG = "1";
  } else if (opts.verbose === true) {
    process.env.BOARDWALK_RUNNER_LOG_LEVEL = "debug";
  }
}

function machineOs(): string | undefined {
  return { linux: "linux", darwin: "macos", win32: "windows" }[process.platform as string];
}
function machineArch(): "x64" | "arm64" | undefined {
  return process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
}
function splitLabels(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Isolation config from the start flags: containerized by default; `--host` is the escape hatch. */
function isolationFromOptions(opts: RunnerStartOptions): IsolationConfig {
  if (opts.host === true) return { mode: "host" };
  const mounts = (opts.mount ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return {
    mode: "container",
    ...(opts.image !== undefined ? { image: opts.image } : {}),
    ...(opts.network !== undefined ? { network: opts.network } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
  };
}

/** `boardwalk runner start` — register if needed, then go online (foreground). */
export async function runRunnerStart(opts: RunnerStartOptions, deps: RunnerDeps): Promise<void> {
  const log = resolveLog(deps);
  applyLogFlags(opts);
  const pool = opts.pool ?? "default";
  const { client, org, baseUrl } = await resolveOrgClient(deps, opts);
  const orgSlug = requireOrg(org);
  const identityDir = deps.identityDir ?? defaultIdentityDir();

  let identity: RunnerIdentity | null = await loadIdentity(identityDir, baseUrl, pool);
  if (identity === null) {
    // One-step enrollment: the management API mints + redeems the registration token server-side
    // under your membership (owner/admin). No token ever appears here.
    const name = opts.name ?? (deps.hostname ?? os.hostname)();
    const osName = machineOs();
    const arch = machineArch();
    const registered = await client.registerRunner(orgSlug, {
      pool,
      name,
      labels: splitLabels(opts.labels),
      ...(osName !== undefined ? { os: osName } : {}),
      ...(arch !== undefined ? { arch } : {}),
    });
    identity = {
      runner_id: registered.runnerId,
      runner_token: registered.runnerToken,
      control_plane_url: baseUrl,
      pool,
      org: orgSlug,
      name,
      created_at: Date.now(),
    };
    const file = await saveIdentity(identityDir, identity);
    log(`Registered runner "${name}" in pool "${pool}" (identity: ${file})`);
  } else {
    log(`Using saved runner identity "${identity.name}" (pool "${pool}")`);
  }

  // The daemon lifecycle + isolation are the runner package's shared startRunner — the same code
  // the standalone `boardwalk-runner` bin runs, so the two entry points can't drift.
  const run = deps.startRunner ?? startRunner;
  await run({
    baseUrl,
    identity,
    isolation: isolationFromOptions(opts),
    workDir: opts.workDir ?? path.join(identityDir, "work"),
    log: (line) => {
      log(line.replace(/\n+$/, ""));
    },
    ...(opts.once === true ? { once: true } : {}),
  });
}

/** `boardwalk runner register` — two-step fleet flow (redeem a token minted elsewhere). */
export async function runRunnerRegister(
  opts: RunnerRegisterOptions,
  deps: RunnerDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name ?? (deps.hostname ?? os.hostname)();
  const osName = machineOs();
  const arch = machineArch();
  const client = new PoolClient({
    baseUrl: opts.url,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const res = await client.register({
    registration_token: opts.registrationToken,
    name,
    labels: splitLabels(opts.labels),
    ...(osName === "linux" || osName === "macos" || osName === "windows" ? { os: osName } : {}),
    ...(arch !== undefined ? { arch } : {}),
  });
  const file = await saveIdentity(deps.identityDir ?? defaultIdentityDir(), {
    runner_id: res.runner_id,
    runner_token: res.runner_token,
    control_plane_url: opts.url,
    pool: res.pool,
    name,
    created_at: Date.now(),
  });
  log(`Registered runner "${name}" in pool "${res.pool}" (identity: ${file})`);
  log(`Start it with: boardwalk runner start --pool ${res.pool}`);
}

/** `boardwalk runner list` */
export async function runRunnerList(opts: RunnerListOptions, deps: RunnerDeps): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const orgSlug = requireOrg(org);
  const [runners, pools] = await Promise.all([
    client.listRunners(orgSlug),
    client.listRunnerPools(orgSlug),
  ]);
  if (opts.json === true) {
    log(JSON.stringify({ runners, pools }, null, 2));
    return;
  }
  if (runners.length === 0) {
    log(
      `No self-hosted runners in ${orgSlug}. Start one with: boardwalk runner start --org ${orgSlug}`,
    );
    return;
  }
  const poolName = new Map(pools.map((p) => [p.id, p.name]));
  for (const r of runners) {
    const seen = r.lastSeenAt === null ? "never" : new Date(r.lastSeenAt).toISOString();
    const labels = r.labels.length > 0 ? `  [${r.labels.join(",")}]` : "";
    log(
      `${r.status.padEnd(9)} ${r.name.padEnd(24)} pool=${poolName.get(r.poolId) ?? r.poolId}` +
        `  ${r.os ?? "?"}/${r.arch ?? "?"}  seen=${seen}  ${r.id}${labels}`,
    );
  }
}

/** `boardwalk runner remove <id>` — deregister (the standing credential dies with the row). */
export async function runRunnerRemove(opts: RunnerRemoveOptions, deps: RunnerDeps): Promise<void> {
  const log = resolveLog(deps);
  if (opts.yes !== true) {
    throw new CliError(
      "Removing a runner kills its credential immediately. Re-run with --yes to confirm.",
    );
  }
  const { client } = await resolveOrgClient(deps, opts);
  await client.deregisterRunner(opts.runnerId);
  log(`Removed runner ${opts.runnerId}.`);
}

/** `boardwalk runner pools token` — mint a one-time registration token (fleet installs). */
export async function runRunnerPoolToken(
  opts: RunnerPoolTokenOptions,
  deps: RunnerDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const pool = opts.pool ?? "default";
  const { client, org, baseUrl } = await resolveOrgClient(deps, opts);
  const minted = await client.mintRunnerToken(requireOrg(org), pool);
  log("One-time registration token (valid 1 hour, shown once):");
  log(`  ${minted.registrationToken}`);
  log("On the target machine:");
  log(`  boardwalk runner register --url ${baseUrl} --token ${minted.registrationToken}`);
}

/** Exported for the `runner list` tests. */
export function formatRunnerCount(runners: readonly RunnerItem[]): string {
  return `${String(runners.length)} runner${runners.length === 1 ? "" : "s"}`;
}
