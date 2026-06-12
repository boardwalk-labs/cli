// `boardwalk init [dir]` — scaffold a new workflow project.
//
// v0.1 ships one built-in template (`hello`) that runs green under `boardwalk dev` immediately;
// the richer template registry comes from the boardwalk-examples repo. Never overwrites: any
// file that already exists at a target path aborts the scaffold before anything is written.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CliError } from "../errors.js";

export interface InitOptions {
  dir: string;
  template: string;
}

export interface InitDeps {
  log?: (line: string) => void;
}

interface Template {
  description: string;
  /** relative path → file contents (a `{{name}}` placeholder is replaced with the project name). */
  files: Record<string, string>;
}

const HELLO_PROGRAM = `import { input, output, type WorkflowMeta } from "@boardwalk/workflow";

export const meta = {
  name: "{{name}}",
  description: "A starting point — run it locally with \`boardwalk dev\`.",
  triggers: [{ kind: "manual" }],
} satisfies WorkflowMeta;

export default async function run(): Promise<void> {
  const who = typeof input === "string" && input.length > 0 ? input : "world";

  // Next step: give it a brain. agent() runs a full agent loop and resolves to its answer:
  //   const greeting = await agent(\`Write a one-line greeting for \${who}.\`);
  // (agent() needs an engine — \`boardwalk run\` today, the local engine soon.)

  output(\`Hello, \${who}!\`);
}
`;

const HELLO_PACKAGE_JSON = `{
  "name": "{{name}}",
  "private": true,
  "type": "module",
  "dependencies": {
    "@boardwalk/workflow": "^0.1.0"
  }
}
`;

const HELLO_ENV_EXAMPLE = `# Secrets for local runs — \`boardwalk dev\` resolves meta.secrets from .env.
# Copy to .env (gitignored) and fill in real values.
# MY_API_KEY=…
`;

const HELLO_GITIGNORE = `node_modules/
.env
.boardwalk/
.bw-runs/
`;

const TEMPLATES: Record<string, Template> = {
  hello: {
    description: "A minimal workflow: input → output, ready for boardwalk dev",
    files: {
      "index.ts": HELLO_PROGRAM,
      "package.json": HELLO_PACKAGE_JSON,
      ".env.example": HELLO_ENV_EXAMPLE,
      ".gitignore": HELLO_GITIGNORE,
    },
  },
};

export function runInit(opts: InitOptions, deps: InitDeps = {}): void {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });

  const template = TEMPLATES[opts.template];
  if (template === undefined) {
    throw new CliError(
      `Unknown template "${opts.template}".`,
      `Available templates: ${Object.keys(TEMPLATES).join(", ")}.`,
    );
  }

  const dir = resolve(opts.dir);
  const name = workflowNameFor(dir);
  mkdirSync(dir, { recursive: true });

  // Refuse to clobber: check every target before writing anything.
  for (const rel of Object.keys(template.files)) {
    if (existsSync(join(dir, rel))) {
      throw new CliError(
        `${rel} already exists in ${dir}.`,
        "boardwalk init only scaffolds into paths it won't overwrite — pick an empty directory.",
      );
    }
  }

  for (const [rel, contents] of Object.entries(template.files)) {
    writeFileSync(join(dir, rel), contents.replaceAll("{{name}}", name));
  }

  log(`✓ scaffolded "${name}" (template: ${opts.template})`);
  for (const rel of Object.keys(template.files)) log(`  ${rel}`);
  log("");
  log("next:");
  log(`  cd ${opts.dir === "." ? "." : opts.dir} && npm install`);
  log("  boardwalk dev index.ts --input '\"there\"'");
}

/** Derive a manifest-legal workflow name from the target directory's basename. */
export function workflowNameFor(absDir: string): string {
  const base = basename(absDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return base.length > 0 ? base : "my-workflow";
}
