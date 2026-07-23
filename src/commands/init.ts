// SPDX-License-Identifier: MIT

// `boardwalk init [dir]` — scaffold a new workflow project.
//
// Templates come from the examples registry: `--template <name>` fetches
// `registry.json` and the template's files from the templates base URL
// ($BOARDWALK_TEMPLATES_URL to point at a fork/mirror). The default `hello` template is
// BUILT IN — `init` works offline and with zero configuration.
//
// After scaffolding, init also writes the Boardwalk agent skills into
// `.claude/skills/` (fetched from the plugins repo; $BOARDWALK_SKILLS_URL to override)
// so a coding agent working in the project can drive the CLI with local context.
// This step is best-effort: offline it is skipped with a note and init still succeeds.
//
// Never overwrites: every target path is checked before anything is written.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "../errors.js";
import { isRecord } from "../guards.js";
import { resolveLog } from "../log.js";

export interface InitOptions {
  dir: string;
  template: string;
}

export interface InitDeps {
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Where templates live: the examples repo, raw. Overridable for forks/mirrors. */
const DEFAULT_TEMPLATES_URL = "https://raw.githubusercontent.com/boardwalk-labs/examples/main";

/** Where the agent skills live: the plugins repo, raw. Overridable for forks/mirrors. */
const DEFAULT_SKILLS_URL =
  "https://raw.githubusercontent.com/boardwalk-labs/plugins/main/plugins/boardwalk/skills";

/** The skills init drops into a fresh project (the CLI surface + authoring quality). */
const INIT_SKILLS = ["boardwalk-use-cli", "write-good-workflows"] as const;

// ── The built-in `hello` template (offline floor) ───────────────────────────────────────
//
// The two-file shape: a `run` function (src/index.ts) + a `workflow.jsonc` deployment descriptor.
// The scaffold defaults to TYPED — an interface in, a typed return out — because the deploy derives
// those types into the dashboard's input form and the callers' contract. A bare `run(input)` is the
// untyped floor, and the tsconfig relaxes `noImplicitAny` so it stays squiggle-free.

const HELLO_DESCRIPTOR = `{
  // The deployment descriptor — what the control plane must know WITHOUT running your code.
  // Your behavior and I/O contract live in src/index.ts; this file is policy, read as data.
  "$schema": "https://boardwalk.sh/schemas/workflow.json",
  "slug": "{{slug}}",
  "title": "{{title}}",
  "triggers": [
    { "kind": "manual" },
    // Run on a schedule, or on an authenticated webhook:
    //   { "kind": "cron", "expr": "0 9 * * 1-5", "timezone": "America/New_York" },
    //   { "kind": "webhook", "auth": "token" },
  ],
  // Secrets the run may read (set values with \`boardwalk secrets set\`):
  //   "permissions": { "secrets": [{ "name": "STRIPE_API_KEY" }] },
  // Cost caps — a breach pauses the run for approval, never a hard kill:
  //   "budget": { "max_usd": 5 },
}
`;

const HELLO_PROGRAM = `import { agent } from "@boardwalk-labs/workflow";

// Your native types ARE the I/O contract: the deploy derives their schemas, so the
// dashboard's run form and other callers know the shape. No annotation is fine too —
// a bare \`run(input)\` receives the raw JSON untouched.
interface Input {
  /** Who to greet (defaults to "world"). */
  name?: string;
}

interface Greeting {
  greeting: string;
}

// The platform calls this function with the trigger's payload; whatever you return is
// the run's output, persisted and handed to whoever called it.
export default async function run(input: Input): Promise<Greeting> {
  const who = input.name ?? "world";
  // agent() runs a full agent loop and resolves to its answer.
  const greeting = await agent(\`Write a one-line greeting for \${who}.\`);
  return { greeting };
}
`;

// Scaffolded filled-in enough to be true on day one, and shaped so editing it is the obvious move.
// A README is the one part of a workflow the dashboard can't derive, so the scaffold writes the
// skeleton rather than leaving a blank page and a note in a skill nobody reads.
const HELLO_README = `# {{title}}

Greets whoever you pass as input. Replace this paragraph with what your workflow is really for:
what it touches, what it costs, and what to do when it pages you. This file is the workflow's
landing page in the Boardwalk dashboard, so write it for whoever debugs the workflow at 3am rather
than whoever wrote it. \`workflow.jsonc\` already states the triggers and the budget, so don't
restate them here.

## Setup

No secrets required. When you add one, declare it under \`permissions.secrets\` in
\`workflow.jsonc\`, set its value with \`boardwalk secrets set\`, and note here how to get one.

## Run

\`\`\`sh
boardwalk check .                                        # validate it locally
boardwalk run . --org <your-org> --input '{"name":"Ada"}'  # deploy, then trigger a real run
\`\`\`

## How it works

\`src/index.ts\` exports the workflow: a \`run(input)\` function the platform calls with the
trigger's payload. Its return value is the run's output. \`workflow.jsonc\` is the deployment
descriptor — the triggers, permissions, and budget the control plane enforces around the run.

## Make it yours

Grow the \`Input\` and return types — the deploy derives their schemas so the dashboard's run form
never lies. Then swap the \`manual\` trigger for a \`cron\` expression to run it on a schedule.
`;

const HELLO_PACKAGE_JSON = `{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "dependencies": {
    "@boardwalk-labs/workflow": "^0.3.0-alpha.4"
  }
}
`;

const HELLO_TSCONFIG = `{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    // Relaxed so the untyped floor — a bare \`run(input)\` with no annotation — stays
    // squiggle-free. Annotate the parameter to opt into the typed contract.
    "noImplicitAny": false,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

const HELLO_GITIGNORE = `node_modules/
.env
.boardwalk/
`;

const BUILTIN_TEMPLATES: Record<string, Record<string, string>> = {
  hello: {
    "workflow.jsonc": HELLO_DESCRIPTOR,
    "src/index.ts": HELLO_PROGRAM,
    "README.md": HELLO_README,
    "package.json": HELLO_PACKAGE_JSON,
    "tsconfig.json": HELLO_TSCONFIG,
    ".gitignore": HELLO_GITIGNORE,
  },
};

// ── Registry shapes (examples/registry.json) ─────────────────────────────────

interface RegistryTemplate {
  name: string;
  description: string;
  secrets: string[];
  files: string[];
}

export async function runInit(opts: InitOptions, deps: InitDeps = {}): Promise<void> {
  const log = resolveLog(deps);

  const builtin = BUILTIN_TEMPLATES[opts.template];
  if (builtin !== undefined) {
    const dir = resolve(opts.dir);
    const slug = workflowSlugFor(dir);
    const title = titleCaseSlug(slug);
    const files = Object.fromEntries(
      Object.entries(builtin).map(([rel, body]) => [
        rel,
        body
          .replaceAll("{{slug}}", slug)
          .replaceAll("{{title}}", title)
          .replaceAll("{{name}}", slug),
      ]),
    );
    scaffold(dir, files);
    log(`✓ scaffolded "${slug}" (template: ${opts.template})`);
    await writeAgentSkills(dir, deps, log);
    finish(log, opts, []);
    return;
  }

  // Remote template: registry lookup, then fetch each listed file.
  const env = deps.env ?? process.env;
  const baseUrl = (env.BOARDWALK_TEMPLATES_URL ?? DEFAULT_TEMPLATES_URL).replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;

  const registry = await fetchRegistry(baseUrl, fetchImpl);
  const template = registry.find((t) => t.name === opts.template);
  if (template === undefined) {
    const available = [...Object.keys(BUILTIN_TEMPLATES), ...registry.map((t) => t.name)];
    throw new CliError(
      `Unknown template "${opts.template}".`,
      `Available templates: ${available.join(", ")}.`,
    );
  }

  const files: Record<string, string> = {};
  for (const rel of template.files) {
    if (rel.startsWith("/") || rel.split("/").some((s) => s === ".." || s === "")) {
      throw new CliError(`The registry lists an unsafe file path: ${rel}`);
    }
    files[rel] = await fetchText(
      `${baseUrl}/templates/${template.name}/${rel}`,
      fetchImpl,
      `template file ${rel}`,
    );
  }

  const dir = resolve(opts.dir);
  scaffold(dir, files);
  log(`✓ scaffolded "${template.name}" (template: ${template.name})`);
  await writeAgentSkills(dir, deps, log);
  finish(log, opts, template.secrets);
}

/**
 * Drop the Boardwalk agent skills into `<dir>/.claude/skills/` so a coding agent working in
 * the project can operate the CLI with local context (the same skills the Boardwalk plugin
 * installs globally). Best-effort by design: init's offline floor must hold, so ANY fetch
 * problem skips the whole step with a note. Fetch-all-then-write keeps it atomic — either
 * every skill lands or none does. Existing files are never overwritten.
 */
async function writeAgentSkills(
  dir: string,
  deps: InitDeps,
  log: (line: string) => void,
): Promise<void> {
  const env = deps.env ?? process.env;
  const baseUrl = (env.BOARDWALK_SKILLS_URL ?? DEFAULT_SKILLS_URL).replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? fetch;

  const bodies: [string, string][] = [];
  try {
    for (const name of INIT_SKILLS) {
      bodies.push([name, await fetchText(`${baseUrl}/${name}/SKILL.md`, fetchImpl, "skill")]);
    }
  } catch {
    log("- skipped agent skills (couldn't reach the skills repo — offline?)");
    log("  they also ship in the Boardwalk plugin: claude plugin install boardwalk@boardwalk-labs");
    return;
  }

  const written: string[] = [];
  for (const [name, body] of bodies) {
    const target = join(dir, ".claude", "skills", name, "SKILL.md");
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
    written.push(name);
  }
  if (written.length > 0) {
    log(`✓ wrote agent skills: .claude/skills/{${written.join(", ")}}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────

/**
 * Files that yield to yours instead of blocking init. Nothing here is load-bearing for the program,
 * and a README you already wrote beats the skeleton we would have written — refusing the whole init
 * over one would punish `boardwalk init .` in any repo that already has a README, which is most of
 * them.
 */
const KEEP_EXISTING = new Set(["README.md"]);

/**
 * All-or-nothing write: refuse if ANY target exists, then write every file. {@link KEEP_EXISTING}
 * paths are dropped from the set first, so an existing one is kept rather than fought over. The
 * filter runs before the existence check, so the abort-writes-nothing property still holds.
 */
function scaffold(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  const pending = Object.entries(files).filter(
    ([rel]) => !(KEEP_EXISTING.has(rel) && existsSync(join(dir, rel))),
  );
  for (const [rel] of pending) {
    if (existsSync(join(dir, rel))) {
      throw new CliError(
        `${rel} already exists in ${dir}.`,
        "boardwalk init only scaffolds into paths it won't overwrite — pick an empty directory.",
      );
    }
  }
  for (const [rel, contents] of pending) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function finish(log: (line: string) => void, opts: InitOptions, secrets: readonly string[]): void {
  log("");
  log("next:");
  log(`  cd ${opts.dir === "." ? "." : opts.dir} && npm install`);
  if (secrets.length > 0) {
    log(`  boardwalk secrets set <name> --org <your-org>   # needed: ${secrets.join(", ")}`);
  }
  log("  boardwalk run . --org <your-org>");
}

async function fetchRegistry(
  baseUrl: string,
  fetchImpl: typeof fetch,
): Promise<RegistryTemplate[]> {
  const raw = await fetchText(`${baseUrl}/registry.json`, fetchImpl, "template registry");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("The template registry is not valid JSON.", registryHint(baseUrl));
  }
  const templates = isRecord(parsed) ? parsed.templates : undefined;
  if (!Array.isArray(templates) || !templates.every(isRegistryTemplate)) {
    throw new CliError("The template registry has an unexpected shape.", registryHint(baseUrl));
  }
  return templates;
}

async function fetchText(url: string, fetchImpl: typeof fetch, what: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new CliError(
      `Could not fetch the ${what} (${url}).`,
      err instanceof Error ? err.message : undefined,
    );
  }
  if (!res.ok) {
    throw new CliError(`Fetching the ${what} failed (${String(res.status)}) at ${url}.`);
  }
  return res.text();
}

function registryHint(baseUrl: string): string {
  return `Registry base: ${baseUrl} (override with BOARDWALK_TEMPLATES_URL).`;
}

function isRegistryTemplate(value: unknown): value is RegistryTemplate {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.secrets) &&
    value.secrets.every((s): s is string => typeof s === "string") &&
    Array.isArray(value.files) &&
    value.files.every((f): f is string => typeof f === "string") &&
    value.files.length > 0
  );
}

/** Derive a manifest-legal workflow slug from the target directory's basename. */
export function workflowSlugFor(absDir: string): string {
  const base = basename(absDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return base.length > 0 ? base : "my-workflow";
}

/** A human-friendly title from a slug: "morning-digest" → "Morning Digest". */
function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}
