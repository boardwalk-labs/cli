// SPDX-License-Identifier: MIT

// `boardwalk init [dir]` — scaffold a new workflow project.
//
// Templates come from the examples registry: `--template <name>` fetches
// `registry.json` and the template's files from the templates base URL
// ($BOARDWALK_TEMPLATES_URL to point at a fork/mirror). The default `hello` template is
// BUILT IN — `init` works offline and with zero configuration.
//
// Never overwrites: every target path is checked before anything is written.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "../errors.js";
import { isRecord } from "../guards.js";

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

// ── The built-in `hello` template (offline floor) ───────────────────────────────────────

const HELLO_PROGRAM = `import { input, output, type WorkflowMeta } from "@boardwalk-labs/workflow";

export const meta = {
  slug: "{{slug}}",
  title: "{{title}}",
  description: "A starting point — run it locally with \`boardwalk dev\`.",
  triggers: [{ kind: "manual" }],
} satisfies WorkflowMeta;

// A workflow is a script: it runs top to bottom, and top-level await just works.
const who = typeof input === "string" && input.length > 0 ? input : "world";

// Next step: give it a brain. agent() runs a full agent loop and resolves to its answer:
//   const greeting = await agent(\`Write a one-line greeting for \${who}.\`);
// (agent() needs an engine — \`boardwalk run\` today, the local engine soon.)

output(\`Hello, \${who}!\`);
`;

const HELLO_PACKAGE_JSON = `{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "dependencies": {
    "@boardwalk-labs/workflow": "^0.1.0"
  }
}
`;

const HELLO_ENV_EXAMPLE = `# Secrets for local runs — \`boardwalk dev\` resolves permissions.secrets from .env.
# Copy to .env (gitignored) and fill in real values.
# MY_API_KEY=…
`;

const HELLO_GITIGNORE = `node_modules/
.env
.boardwalk/
.bw-runs/
`;

const BUILTIN_TEMPLATES: Record<string, Record<string, string>> = {
  hello: {
    "index.ts": HELLO_PROGRAM,
    "package.json": HELLO_PACKAGE_JSON,
    ".env.example": HELLO_ENV_EXAMPLE,
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
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });

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
    finish(log, opts, slug, opts.template, []);
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

  scaffold(resolve(opts.dir), files);
  finish(log, opts, template.name, template.name, template.secrets);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────

/** All-or-nothing write: refuse if ANY target exists, then write every file. */
function scaffold(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const rel of Object.keys(files)) {
    if (existsSync(join(dir, rel))) {
      throw new CliError(
        `${rel} already exists in ${dir}.`,
        "boardwalk init only scaffolds into paths it won't overwrite — pick an empty directory.",
      );
    }
  }
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
}

function finish(
  log: (line: string) => void,
  opts: InitOptions,
  name: string,
  template: string,
  secrets: readonly string[],
): void {
  log(`✓ scaffolded "${name}" (template: ${template})`);
  log("");
  log("next:");
  log(`  cd ${opts.dir === "." ? "." : opts.dir} && npm install`);
  if (secrets.length > 0) {
    log(`  cp .env.example .env   # fill in: ${secrets.join(", ")}`);
  }
  log("  boardwalk dev .");
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
