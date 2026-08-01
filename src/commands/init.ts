// SPDX-License-Identifier: MIT

// `boardwalk init [dir]` — scaffold a new workflow project.
//
// Templates come from the examples registry: `--template <name>` fetches
// `registry.json` and the template's files from the templates base URL
// ($BOARDWALK_TEMPLATES_URL to point at a fork/mirror). The default `hello` template is
// BUILT IN — `init` works offline and with zero configuration.
//
// init writes the PACKAGE and nothing else. It deliberately does NOT vendor the Boardwalk
// agent skills into `.claude/skills/`: a copy fetched at scaffold time is pinned to nothing,
// ages the moment the CLI upgrades, and lands in the user's repo as ~37KB of frozen docs it
// then has to maintain. The plugin (`claude plugin install boardwalk@boardwalk-labs`) delivers
// the same skills globally and updates with the plugin, so `finish` points there instead.
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
  /** `--python`: scaffold the built-in Python template (main.py + pyproject.toml). */
  python?: boolean | undefined;
}

export interface InitDeps {
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Where templates live: the examples repo, raw. Overridable for forks/mirrors. */
const DEFAULT_TEMPLATES_URL = "https://raw.githubusercontent.com/boardwalk-labs/examples/main";

// ── The built-in `hello` template (offline floor) ───────────────────────────────────────
//
// The two-file shape: a `run` function (src/index.ts) + a `workflow.jsonc` deployment descriptor.
// The scaffold defaults to TYPED — an interface in, an explicit return out — because the deploy
// derives those types into the dashboard's input form and the callers' contract. A bare
// `run(input)` is the untyped floor, and the tsconfig relaxes `noImplicitAny` so it stays
// squiggle-free.
//
// Kept SHORT on purpose. The scaffold's job is a correct starting point you can read in one
// screen, not a tutorial: every commented-out option here is a line the author has to read and
// then delete. The reference lives in the docs and the JSON schema, which stay current; a comment
// baked into a generated file does not.

const HELLO_DESCRIPTOR = `{
  // Deployment policy, read as data — triggers, permissions, budget.
  // Your behavior and I/O contract live in src/index.ts.
  "$schema": "https://boardwalk.sh/schemas/workflow.json",
  "slug": "{{slug}}",
  "title": "{{title}}",
  "triggers": [{ "kind": "manual" }],
}
`;

const HELLO_PROGRAM = `import { agent } from "@boardwalk-labs/workflow";

interface Input {
  name?: string;
}

// Your native types are the I/O contract: the deploy derives their schemas for the
// dashboard's run form. Whatever you return is the run's output.
export default async function run(input: Input): Promise<{ greeting: string }> {
  return { greeting: await agent(\`Write a one-line greeting for \${input.name ?? "world"}.\`) };
}
`;

// A README is the one part of a workflow the dashboard can't derive, so the scaffold writes a
// skeleton rather than leaving a blank page. Short enough to be replaced, not edited around.
const HELLO_README = `# {{title}}

Greets whoever you pass as input. Replace this with what your workflow is really for: what it
touches, what it costs, and what to do when it pages you. This file is the workflow's landing page
in the Boardwalk dashboard, so write it for whoever debugs the run at 3am.

\`\`\`sh
boardwalk check .
boardwalk deploy . --org <your-org> --run --input '{"name":"Ada"}'
\`\`\`
`;

const HELLO_PACKAGE_JSON = `{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "dependencies": {
    "@boardwalk-labs/workflow": "^0.3.0"
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

// ── The built-in Python template (`init --python`, offline like `hello`) ────────────────
//
// The same two-file shape in Python: a `run` function (main.py) + the descriptor. Mirrors the
// package-format spec's §10 example — pydantic models in/out, `async def run` — because native
// types ARE the I/O contract in both languages. Dependencies resolve at build time with uv; the
// `boardwalk` SDK ships in the runtime, so the scaffold does not declare it as a dependency (it
// IS on PyPI — uncommenting it only buys editor type-checking, and costs artifact bytes).

const HELLO_PY_DESCRIPTOR = `{
  // Deployment policy, read as data — triggers, permissions, budget.
  // Your behavior and I/O contract live in main.py.
  "$schema": "https://boardwalk.sh/schemas/workflow.json",
  "slug": "{{slug}}",
  "title": "{{title}}",
  "entry": "main.py",
  "triggers": [{ "kind": "manual" }],
}
`;

const HELLO_PY_PROGRAM = `from typing import Literal

from boardwalk import agent  # a capability - imported, like boto3
from pydantic import BaseModel


# Your native types are the I/O contract: the deploy derives their schemas for the
# dashboard's run form. Whatever you return is the run's output.
class Lead(BaseModel):
    email: str
    company: str


class Score(BaseModel):
    score: int
    tier: Literal["hot", "warm", "cold"]


async def run(input: Lead) -> Score:
    signals = await agent(f"Find buying signals for {input.company}")
    score = int(await agent(f"Score 0-100, reply with digits only:\\n{signals}"))
    return Score(score=score, tier="hot" if score > 70 else "warm" if score > 40 else "cold")
`;

const HELLO_PY_PYPROJECT = `[project]
name = "{{slug}}"
version = "0.0.0"
requires-python = ">=3.13"
dependencies = [
  "pydantic>=2",
  # The \`boardwalk\` SDK ships in the Boardwalk runtime — a deploy needs no install here.
  # Uncomment for editor type-checking (it costs artifact bytes, nothing else):
  # "boardwalk",
]
`;

const HELLO_PY_README = `# {{title}}

Scores an inbound lead. Replace this with what your workflow is really for: what it touches, what
it costs, and what to do when it pages you. This file is the workflow's landing page in the
Boardwalk dashboard, so write it for whoever debugs the run at 3am.

Dependencies in \`pyproject.toml\` are resolved and frozen with \`uv\` at build time and ship inside
the artifact, so nothing installs when a run starts.

\`\`\`sh
boardwalk check .
boardwalk deploy . --org <your-org> --run --input '{"email":"ada@example.com","company":"Acme"}'
\`\`\`
`;

const HELLO_PY_GITIGNORE = `.venv/
__pycache__/
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
  "hello-python": {
    "workflow.jsonc": HELLO_PY_DESCRIPTOR,
    "main.py": HELLO_PY_PROGRAM,
    "pyproject.toml": HELLO_PY_PYPROJECT,
    "README.md": HELLO_PY_README,
    ".gitignore": HELLO_PY_GITIGNORE,
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

  let templateName = opts.template;
  if (opts.python === true) {
    if (opts.template !== "hello" && opts.template !== "hello-python") {
      throw new CliError(
        "--python and --template are mutually exclusive.",
        "`--python` selects the built-in Python template; drop one of the flags.",
      );
    }
    templateName = "hello-python";
  }

  const builtin = BUILTIN_TEMPLATES[templateName];
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
    log(`✓ scaffolded "${slug}" (template: ${templateName})`);
    finish(log, opts, [], templateName === "hello-python" ? "python" : "typescript");
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
  finish(log, opts, template.secrets);
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

function finish(
  log: (line: string) => void,
  opts: InitOptions,
  secrets: readonly string[],
  language: "typescript" | "python" = "typescript",
): void {
  log("");
  log("next:");
  if (language === "python") {
    // No install step: deps resolve at build/deploy time with uv. A local venv is editor comfort.
    log(`  cd ${opts.dir === "." ? "." : opts.dir}   # optional: \`uv sync\` for editor support`);
  } else {
    log(`  cd ${opts.dir === "." ? "." : opts.dir} && npm install`);
  }
  if (secrets.length > 0) {
    log(`  boardwalk secrets set <name> --org <your-org>   # needed: ${secrets.join(", ")}`);
  }
  log("  boardwalk deploy . --org <your-org> --run");
  // The skills are NOT vendored into the project (see the module header): pointing at the plugin
  // keeps one copy that upgrades, instead of a frozen one per scaffolded repo.
  log("");
  log("  to teach your coding agent the CLI:");
  log("  claude plugin install boardwalk@boardwalk-labs");
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
