// SPDX-License-Identifier: MIT

// `boardwalk setup` — the install wizard's brain. One command that gets a machine ready to build
// Boardwalk workflows with a coding agent:
//   1. ensure you're logged in (runs the browser OAuth flow if not),
//   2. detect which coding agent you use (Claude Code / Codex / Cursor / OpenCode / OpenClaw),
//   3. install that agent's Boardwalk plugin + skills and point it at the control-plane MCP server.
//
// It deliberately does NOT touch files in your repo (no CLAUDE.md / AGENTS.md writing) — it installs
// the CLI's companion pieces and leaves your project alone. The thin `@boardwalk-labs/setup` npx
// shim installs the CLI (if missing) and then calls this; everything real lives here so there's one
// tested code path whether you arrive via `npx @boardwalk-labs/setup` or `boardwalk setup`.
//
// Interactive by default; fully scriptable via flags: `--harness <ids>` skips detection, `--yes`
// suppresses prompts (a non-TTY without `--yes` degrades to `--print-only` so it can't hang), and
// `--token`/`BOARDWALK_API_KEY` cover headless auth. Every side effect (subprocess, prompt, login,
// detection) is an injected dep, so the whole flow is unit-tested without spawning or a browser.

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken, resolveBaseUrl } from "../auth/resolve.js";
import { BoardwalkClient } from "../client.js";
import { resolveLog } from "../log.js";
import type { FetchLike } from "../auth/pkce.js";
import { runLogin, type SessionDeps, type LoginOptions } from "./session.js";
import { stdioPrompter, type Prompter, type Choice } from "../prompt.js";
import { runCommand, commandExists, type RunCommand } from "../setup/spawn.js";
import {
  HARNESSES,
  harnessById,
  detectHarnesses,
  type HarnessDef,
  type HarnessId,
  type DetectDeps,
} from "../setup/harness.js";

export interface SetupOptions {
  /** Comma-separated harness ids to set up; skips detection + the pick prompt. */
  harness?: string | undefined;
  /** Non-interactive: no prompts. Uses `--harness` or the detected set; errors if that's empty. */
  yes?: boolean | undefined;
  /** Print the plan without running any installer (also the automatic fallback for a non-TTY run). */
  printOnly?: boolean | undefined;
  /** Skip the login step — for CI where `BOARDWALK_API_KEY` / `--token` is already in the env. */
  skipLogin?: boolean | undefined;
  /** Store this API key (`bwk_…`) instead of running the browser OAuth flow. */
  token?: string | undefined;
}

export interface SetupDeps {
  config: CliConfig;
  log?: (line: string) => void;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: number;
  cwd?: string;
  /** Question surface (defaults to real stdio); injected in tests. */
  prompter?: Prompter;
  /** Subprocess runner (defaults to a real spawn); injected in tests. */
  runCommand?: RunCommand;
  /** Harness-detection deps; defaults probe PATH + the home config dirs. */
  detect?: DetectDeps;
  /** Whether we're attached to a terminal (defaults to `process.stdout.isTTY`). */
  isTty?: boolean;
  /** The login flow (defaults to the real browser OAuth); injected so tests don't open a browser. */
  loginImpl?: (deps: SessionDeps, opts: LoginOptions) => Promise<void>;
  setExitCode?: (code: number) => void;
}

export async function runSetup(opts: SetupOptions, deps: SetupDeps): Promise<void> {
  const log = resolveLog(deps);
  const env = deps.env ?? process.env;
  const setExitCode =
    deps.setExitCode ??
    ((code: number): void => {
      process.exitCode = code;
    });

  // A non-TTY run with neither --yes nor an explicit --harness has no way to answer a prompt, so
  // downgrade to a dry run instead of blocking on stdin that will never arrive.
  const isTty = deps.isTty ?? process.stdout.isTTY;
  const printOnly =
    opts.printOnly === true ||
    (!isTty && opts.yes !== true && (opts.harness ?? "").trim().length === 0);
  const interactive = isTty && opts.yes !== true && !printOnly;
  const prompter = deps.prompter ?? stdioPrompter();

  log("Boardwalk setup");
  log("Gets your CLI + coding agent ready. It won't touch files in your project.");
  if (printOnly) log("(dry run — printing the plan, running nothing)");

  await ensureLoggedIn(opts, deps, { log, env, interactive, printOnly });

  const chosen = await chooseHarnesses(opts, deps, { log, interactive, prompter });
  if (chosen.length === 0) {
    log("");
    log("No agent selected — nothing to install. Re-run `boardwalk setup` any time.");
    return;
  }

  let anyFailed = false;
  for (const h of chosen) {
    const ok = await installHarness(h, {
      printOnly,
      log,
      runCommand: deps.runCommand ?? runCommand,
    });
    anyFailed = anyFailed || !ok;
  }

  printMcpGuidance(chosen, deps.config, env, log);
  printNextSteps(log);

  if (anyFailed) setExitCode(1);
}

// ── Auth ─────────────────────────────────────────────────────────────────────────────────

interface AuthCtx {
  log: (line: string) => void;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  printOnly: boolean;
}

/** Make sure a working credential is in place: report the account if one probes OK, else run login
 *  (interactively) or print how to authenticate (headless). Never hard-fails — the plugin install
 *  doesn't need auth to succeed, so a login problem is a warning, not a stop. */
async function ensureLoggedIn(opts: SetupOptions, deps: SetupDeps, ctx: AuthCtx): Promise<void> {
  ctx.log("");
  ctx.log("Account");

  // --token persists the key first (like `boardwalk login --token`), so the probe below sees it.
  if ((opts.token ?? "").trim().length > 0 && !ctx.printOnly) {
    await callLogin(deps, { token: opts.token });
  }

  const email = await probeAccount(deps, ctx.env);
  if (email !== null) {
    ctx.log(`  ✓ logged in as ${email}`);
    return;
  }

  if (opts.skipLogin === true || ctx.printOnly) {
    ctx.log("  • not logged in — run `boardwalk login` (skipped here)");
    return;
  }

  if (!ctx.interactive) {
    ctx.log("  • not logged in — run `boardwalk login`, or set BOARDWALK_API_KEY / pass --token");
    return;
  }

  await callLogin(deps, {});
  const after = await probeAccount(deps, ctx.env);
  ctx.log(after !== null ? `  ✓ logged in as ${after}` : "  • login didn't complete — continuing");
}

function callLogin(deps: SetupDeps, opts: LoginOptions): Promise<void> {
  const login = deps.loginImpl ?? runLogin;
  const sessionDeps: SessionDeps = {
    config: deps.config,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  return login(sessionDeps, opts);
}

/** Resolve the effective credential (flag/env/session) and probe `GET /v1/me`; the account email on
 *  success, else null (no credential, rejected, or the host was unreachable). Never throws. */
async function probeAccount(deps: SetupDeps, env: NodeJS.ProcessEnv): Promise<string | null> {
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const envKey = (env.BOARDWALK_API_KEY ?? "").trim();
  if (envKey.length === 0 && store.getSession() === null) return null;

  const baseUrl = resolveBaseUrl({
    config: deps.config,
    session: store.getSession(),
    usingFlag: false,
    usingEnvKey: envKey.length > 0,
  }).url;

  let token: string;
  try {
    token = await resolveToken({
      config: deps.config,
      store,
      env,
      ...(deps.now !== undefined ? { now: deps.now } : {}),
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    return null;
  }

  const client = new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  try {
    const me = await client.getMe();
    return me.user.email;
  } catch {
    return null;
  }
}

// ── Harness selection ──────────────────────────────────────────────────────────────────────

interface ChooseCtx {
  log: (line: string) => void;
  interactive: boolean;
  prompter: Prompter;
}

async function chooseHarnesses(
  opts: SetupOptions,
  deps: SetupDeps,
  ctx: ChooseCtx,
): Promise<HarnessDef[]> {
  if ((opts.harness ?? "").trim().length > 0) {
    return parseHarnessIds(opts.harness ?? "");
  }

  const detected = await detectHarnesses(deps.detect ?? defaultDetectDeps(deps.runCommand));

  ctx.log("");
  ctx.log("Coding agent");

  if (!ctx.interactive) {
    if (detected.length === 0) {
      throw new CliError(
        "No coding agent detected.",
        `Re-run with --harness <ids> — one or more of: ${allHarnessIds()}.`,
      );
    }
    ctx.log(`  detected: ${detected.map((h) => h.label).join(", ")}`);
    return detected;
  }

  const only = detected[0];
  if (only === undefined) {
    const pick = await ctx.prompter.select<HarnessId>(
      "  No coding agent detected — which do you use?",
      HARNESSES.map((h) => toChoice(h)),
    );
    const picked = harnessById(pick);
    return picked === undefined ? [] : [picked];
  }

  if (detected.length === 1) {
    const yes = await ctx.prompter.confirm(`  Set up ${only.label} (detected)?`, true);
    return yes ? [only] : [];
  }

  const chosen = await ctx.prompter.multiselect<HarnessId>(
    "  Which agents should I set up?",
    HARNESSES.map((h) => toChoice(h, detected.includes(h))),
    detected.map((h) => h.id),
  );
  return chosen.map((id) => harnessById(id)).filter((h): h is HarnessDef => h !== undefined);
}

function parseHarnessIds(raw: string): HarnessDef[] {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: HarnessDef[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const h = harnessById(id);
    if (h === undefined) unknown.push(id);
    else if (!out.includes(h)) out.push(h);
  }
  if (unknown.length > 0) {
    throw new CliError(
      `Unknown agent id: ${unknown.join(", ")}.`,
      `Valid ids: ${allHarnessIds()}.`,
    );
  }
  return out;
}

function toChoice(h: HarnessDef, detected = false): Choice<HarnessId> {
  return {
    value: h.id,
    label: h.label,
    ...(detected ? { hint: "detected" } : h.automated ? {} : { hint: "guided" }),
  };
}

function allHarnessIds(): string {
  return HARNESSES.map((h) => h.id).join(", ");
}

/** Default detection: probe PATH (`which`/`where`) + look for each agent's home config dir. */
function defaultDetectDeps(run?: RunCommand): DetectDeps {
  return {
    commandExists: (bin) => commandExists(bin, run),
    dirExists: (p) => existsSync(p) && statSync(p).isDirectory(),
    homeDir: homedir(),
  };
}

// ── Install ────────────────────────────────────────────────────────────────────────────────

interface InstallCtx {
  printOnly: boolean;
  log: (line: string) => void;
  runCommand: RunCommand;
}

/** Run (or print) one harness's steps. Returns false if any executed step exited non-zero. */
async function installHarness(h: HarnessDef, ctx: InstallCtx): Promise<boolean> {
  ctx.log("");
  ctx.log(h.label);
  let ok = true;
  for (const step of h.steps) {
    if (step.kind === "manual") {
      ctx.log(`  • ${step.title}`);
      for (const line of step.body) ctx.log(`      ${line}`);
      continue;
    }
    const shown = `${step.cmd} ${step.args.join(" ")}`;
    ctx.log(`  • ${step.title}`);
    ctx.log(`      $ ${shown}`);
    if (ctx.printOnly) continue;
    const res = await ctx.runCommand(step.cmd, step.args, { inherit: true });
    if (res.code === 0) {
      ctx.log("      ✓ done");
    } else {
      ok = false;
      ctx.log(
        `      ✗ exited ${String(res.code)}${res.code === 127 ? " (command not found)" : ""}`,
      );
    }
  }
  return ok;
}

// ── MCP + next steps ─────────────────────────────────────────────────────────────────────────

/** The control-plane MCP server ships inside the Claude Code plugin (auto-loaded) and connects
 *  elsewhere manually; either way it authenticates with a Boardwalk API key, which by design is
 *  minted in the browser (a CLI token can't create one). So this guides the one human-only step. */
function printMcpGuidance(
  chosen: HarnessDef[],
  config: CliConfig,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): void {
  log("");
  log("Control-plane MCP");
  const hasKey = (env.BOARDWALK_API_KEY ?? "").trim().length > 0;
  const includesClaude = chosen.some((h) => h.id === "claude-code");

  if (includesClaude) {
    log(
      "  • The Claude Code plugin bundles the Boardwalk MCP server (loads when the plugin is on).",
    );
  }
  if (chosen.some((h) => h.id !== "claude-code")) {
    log("  • Connect it in other agents, e.g.:");
    log(
      `      claude mcp add --transport http boardwalk ${config.apiBaseUrl}/mcp/v1 \\\n        --header "Authorization: Bearer $BOARDWALK_API_KEY"`,
    );
  }
  if (hasKey) {
    log("  ✓ BOARDWALK_API_KEY is set — the MCP server will connect.");
  } else {
    const url = consoleApiKeysUrl(config.apiBaseUrl);
    log("  • It authenticates with a Boardwalk API key. Create one in the web console");
    log(
      `    (Settings → API keys${url === null ? "" : `: ${url}`}), then:  export BOARDWALK_API_KEY=bwk_…`,
    );
  }
}

function printNextSteps(log: (line: string) => void): void {
  log("");
  log("Next");
  log("  boardwalk init my-workflow   # scaffold a workflow");
  log("  boardwalk dev .              # run it locally — no account needed");
  log("  Then ask your agent to build one; it now knows the CLI.");
}

/** Best-effort web-console API-keys URL: `api.<domain>` → `app.<domain>`. Null if we can't guess. */
function consoleApiKeysUrl(apiBaseUrl: string): string | null {
  try {
    const u = new URL(apiBaseUrl);
    if (u.hostname.startsWith("api.")) {
      return `${u.protocol}//app.${u.hostname.slice("api.".length)}/settings/api-keys`;
    }
    return null;
  } catch {
    return null;
  }
}
