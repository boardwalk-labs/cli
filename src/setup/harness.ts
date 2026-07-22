// SPDX-License-Identifier: MIT

// The coding agents `boardwalk setup` knows how to wire up, and how to detect + install each. A
// "harness" is an agent runtime that can drive the Boardwalk CLI: Claude Code, Codex, Cursor,
// OpenCode, OpenClaw. Each entry declares how we DETECT it (a PATH binary or a config dir) and the
// STEPS to install its Boardwalk plugin/skills.
//
// Two step kinds: `run` (the wizard executes an installer, e.g. `claude plugin install`) and
// `manual` (we print an exact recipe for the harnesses whose install still needs a repo checkout /
// a pending marketplace). Keeping the recipes here — one table, single source of truth — means the
// wizard and `boardwalk setup --print-only` render the same thing, and it stays in lockstep with the
// plugins repo README rather than drifting across three copies.

export type HarnessId = "claude-code" | "codex" | "cursor" | "opencode" | "openclaw";

export type SetupStep =
  | { kind: "run"; title: string; cmd: string; args: string[] }
  | { kind: "manual"; title: string; body: string[] };

export interface HarnessDef {
  id: HarnessId;
  label: string;
  /** PATH binaries that signal this agent is installed — any one match counts. */
  bins: string[];
  /** Home-relative dirs that also signal it (any exists), e.g. ".claude", ".config/opencode". */
  dirs: string[];
  /** True when every step is a `run` we execute; false when the harness needs a guided recipe. */
  automated: boolean;
  steps: SetupStep[];
}

/** The published Claude-Code marketplace + plugin refs (see boardwalk-labs/plugins). */
export const MARKETPLACE_REF = "boardwalk-labs/plugins";
export const PLUGIN_REF = "boardwalk@boardwalk-labs";

export const HARNESSES: readonly HarnessDef[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bins: ["claude"],
    dirs: [".claude"],
    automated: true,
    steps: [
      {
        kind: "run",
        title: "Add the Boardwalk marketplace",
        cmd: "claude",
        args: ["plugin", "marketplace", "add", MARKETPLACE_REF],
      },
      {
        kind: "run",
        title: "Install the Boardwalk plugin (skills + control-plane MCP)",
        cmd: "claude",
        args: ["plugin", "install", PLUGIN_REF],
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    bins: ["codex"],
    dirs: [".codex"],
    automated: true,
    steps: [
      {
        kind: "run",
        title: "Add the Boardwalk plugin",
        cmd: "npx",
        args: ["-y", "codex-plugin", "add", MARKETPLACE_REF],
      },
      {
        kind: "manual",
        title: "Enable it",
        body: ["Open `/plugins` in Codex and turn on `boardwalk`."],
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor",
    bins: ["cursor"],
    dirs: [".cursor"],
    automated: false,
    steps: [
      {
        kind: "manual",
        title: "Link the plugin (Cursor Marketplace is pending)",
        body: [
          "From a checkout of the plugins repo:",
          `  git clone https://github.com/${MARKETPLACE_REF}`,
          '  ln -s "$(pwd)" ~/.cursor/plugins/local/boardwalk',
        ],
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    bins: ["opencode"],
    dirs: [".config/opencode"],
    automated: false,
    steps: [
      {
        kind: "manual",
        title: "Link the skill (OpenCode loads Agent Skills natively)",
        body: [
          "From a checkout of the plugins repo:",
          "  mkdir -p ~/.config/opencode/skills",
          '  ln -s "$(pwd)/plugins/boardwalk/skills/boardwalk-use-cli" \\',
          "    ~/.config/opencode/skills/boardwalk-use-cli",
          "If you installed the Claude Code plugin, OpenCode also finds skills under ~/.claude/skills/.",
        ],
      },
    ],
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    bins: ["openclaw"],
    dirs: [],
    automated: false,
    steps: [
      {
        kind: "manual",
        title: "Install the plugin",
        body: ["From a checkout of the plugins repo:", "  openclaw plugins install ./"],
      },
    ],
  },
] as const;

export function harnessById(id: string): HarnessDef | undefined {
  return HARNESSES.find((h) => h.id === id);
}

/** The dependencies detection needs — injected so tests decide which agents "exist". */
export interface DetectDeps {
  commandExists: (bin: string) => Promise<boolean>;
  dirExists: (absPath: string) => boolean;
  homeDir: string;
}

/** Whether one harness looks installed: any of its bins on PATH, or any of its config dirs present. */
export async function isHarnessPresent(h: HarnessDef, deps: DetectDeps): Promise<boolean> {
  for (const dir of h.dirs) {
    if (deps.dirExists(joinHome(deps.homeDir, dir))) return true;
  }
  for (const bin of h.bins) {
    if (await deps.commandExists(bin)) return true;
  }
  return false;
}

/** The harnesses that look installed on this machine, in table order. */
export async function detectHarnesses(deps: DetectDeps): Promise<HarnessDef[]> {
  const present: HarnessDef[] = [];
  for (const h of HARNESSES) {
    if (await isHarnessPresent(h, deps)) present.push(h);
  }
  return present;
}

function joinHome(home: string, rel: string): string {
  const trimmedHome = home.replace(/[/\\]+$/, "");
  return `${trimmedHome}/${rel}`;
}
