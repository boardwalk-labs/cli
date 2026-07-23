// SPDX-License-Identifier: MIT

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, workflowSlugFor } from "./init.js";
import { loadDescriptor } from "../descriptor.js";

/** A fetch serving an in-memory registry + template files (no network). */
function registryFetch(files: Record<string, string>): typeof fetch {
  const impl = (url: string | URL | Request): Promise<Response> => {
    const path = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url)
      .pathname;
    const body = files[path];
    return Promise.resolve(
      body === undefined ? new Response("not found", { status: 404 }) : new Response(body),
    );
  };
  return impl;
}

const REGISTRY = JSON.stringify({
  version: 1,
  templates: [
    {
      name: "remote-digest",
      description: "A registry template.",
      secrets: ["API_KEY"],
      files: ["workflow.jsonc", "src/index.ts", "package.json", ".env.example", "lib/util.ts"],
    },
  ],
});

const REMOTE_FILES: Record<string, string> = {
  "/registry.json": REGISTRY,
  "/templates/remote-digest/workflow.jsonc": `{ "slug": "remote-digest", "triggers": [{ "kind": "manual" }] }`,
  "/templates/remote-digest/src/index.ts": `export default async function run() {
  console.log("remote-digest ran");
}`,
  "/templates/remote-digest/package.json": `{ "name": "remote-digest", "private": true }`,
  "/templates/remote-digest/.env.example": "API_KEY=…\n",
  "/templates/remote-digest/lib/util.ts": "export const x = 1;\n",
};

const ENV = { BOARDWALK_TEMPLATES_URL: "https://templates.test" };

/** A fetch that fails every call — the offline floor. */
const offlineFetch = (() => {
  throw new Error("offline");
}) as unknown as typeof fetch;

const SKILLS_ENV = { BOARDWALK_SKILLS_URL: "https://skills.test" };

const SKILL_FILES: Record<string, string> = {
  "/boardwalk-use-cli/SKILL.md": "---\nname: boardwalk-use-cli\n---\nUse the CLI.\n",
  "/write-good-workflows/SKILL.md": "---\nname: write-good-workflows\n---\nWrite well.\n",
};

describe("runInit (built-in template)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds hello: the two-file shape (descriptor + typed run), offline (skills skipped with a note)", async () => {
    const target = join(dir, "my-digest");
    const lines: string[] = [];
    await runInit(
      { dir: target, template: "hello" },
      { log: (l) => lines.push(l), fetchImpl: offlineFetch },
    );

    for (const f of [
      "workflow.jsonc",
      join("src", "index.ts"),
      "README.md",
      "package.json",
      "tsconfig.json",
      ".gitignore",
    ]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    // The descriptor is schema-valid as scaffolded (slug from the directory name).
    const { descriptor } = loadDescriptor(target);
    expect(descriptor.slug).toBe("my-digest");
    expect(descriptor.triggers).toEqual([{ kind: "manual" }]);
    // The program is the function model: a typed default-export run + one agent() call.
    const program = readFileSync(join(target, "src", "index.ts"), "utf8");
    expect(program).toContain("export default async function run");
    expect(program).toContain("agent(");
    expect(program).not.toContain("output(");
    expect(program).not.toContain("meta");
    // The tsconfig relaxes noImplicitAny so the bare-param untyped floor is squiggle-free.
    expect(readFileSync(join(target, "tsconfig.json"), "utf8")).toContain('"noImplicitAny": false');
    const out = lines.join("\n");
    expect(out).toContain('scaffolded "my-digest"');
    expect(out).toContain("skipped agent skills");
    expect(existsSync(join(target, ".claude"))).toBe(false);
  });

  it("titles the README after the workflow, so it ships as the dashboard landing page", async () => {
    const target = join(dir, "my-digest");
    await runInit(
      { dir: target, template: "hello" },
      { log: () => undefined, fetchImpl: offlineFetch },
    );
    expect(readFileSync(join(target, "README.md"), "utf8")).toMatch(/^# My Digest\n/);
  });

  it("keeps a README you already have instead of refusing to init", async () => {
    const target = join(dir, "has-readme");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "README.md"), "mine\n");
    await runInit(
      { dir: target, template: "hello" },
      { log: () => undefined, fetchImpl: offlineFetch },
    );
    expect(readFileSync(join(target, "README.md"), "utf8")).toBe("mine\n");
    expect(existsSync(join(target, "src", "index.ts"))).toBe(true);
  });

  it("refuses to overwrite existing files", async () => {
    const target = join(dir, "taken");
    await runInit(
      { dir: target, template: "hello" },
      { log: () => undefined, fetchImpl: offlineFetch },
    );
    await expect(
      runInit(
        { dir: target, template: "hello" },
        { log: () => undefined, fetchImpl: offlineFetch },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("aborts before writing anything when one target exists", async () => {
    const target = join(dir, "partial");
    await runInit(
      { dir: target, template: "hello" },
      { log: () => undefined, fetchImpl: offlineFetch },
    );
    rmSync(join(target, "package.json"));
    writeFileSync(join(target, ".gitignore"), "mine\n");
    await expect(
      runInit(
        { dir: target, template: "hello" },
        { log: () => undefined, fetchImpl: offlineFetch },
      ),
    ).rejects.toThrow(/already exists/);
    expect(existsSync(join(target, "package.json"))).toBe(false);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("mine\n");
  });
});

describe("runInit (agent skills)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-init-skills-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the agent skills into .claude/skills/ when the skills repo is reachable", async () => {
    const target = join(dir, "with-skills");
    const lines: string[] = [];
    await runInit(
      { dir: target, template: "hello" },
      { log: (l) => lines.push(l), fetchImpl: registryFetch(SKILL_FILES), env: SKILLS_ENV },
    );

    expect(
      readFileSync(join(target, ".claude", "skills", "boardwalk-use-cli", "SKILL.md"), "utf8"),
    ).toContain("Use the CLI");
    expect(
      readFileSync(join(target, ".claude", "skills", "write-good-workflows", "SKILL.md"), "utf8"),
    ).toContain("Write well");
    expect(lines.join("\n")).toContain("wrote agent skills");
  });

  it("skips ALL skills when any one is missing (atomic, init still succeeds)", async () => {
    const target = join(dir, "partial-skills");
    const partial = { ...SKILL_FILES };
    delete partial["/write-good-workflows/SKILL.md"];
    const lines: string[] = [];
    await runInit(
      { dir: target, template: "hello" },
      { log: (l) => lines.push(l), fetchImpl: registryFetch(partial), env: SKILLS_ENV },
    );

    expect(existsSync(join(target, ".claude"))).toBe(false);
    expect(lines.join("\n")).toContain("skipped agent skills");
    expect(existsSync(join(target, "src", "index.ts"))).toBe(true);
  });

  it("writes skills after a registry template too", async () => {
    const target = join(dir, "remote-with-skills");
    // One mock serves both hosts — registryFetch matches on pathname only.
    await runInit(
      { dir: target, template: "remote-digest" },
      {
        log: () => undefined,
        fetchImpl: registryFetch({ ...REMOTE_FILES, ...SKILL_FILES }),
        env: { ...ENV, ...SKILLS_ENV },
      },
    );

    expect(existsSync(join(target, ".claude", "skills", "boardwalk-use-cli", "SKILL.md"))).toBe(
      true,
    );
    expect(existsSync(join(target, "lib", "util.ts"))).toBe(true);
  });
});

describe("runInit (registry template)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-init-remote-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fetches the registry + every listed file (nested paths included), verbatim", async () => {
    const target = join(dir, "digest");
    const lines: string[] = [];
    await runInit(
      { dir: target, template: "remote-digest" },
      { log: (l) => lines.push(l), fetchImpl: registryFetch(REMOTE_FILES), env: ENV },
    );

    expect(readFileSync(join(target, "lib", "util.ts"), "utf8")).toBe("export const x = 1;\n");
    const { descriptor } = loadDescriptor(target);
    expect(descriptor.slug).toBe("remote-digest"); // verbatim — no {{name}} substitution
    const out = lines.join("\n");
    expect(out).toContain("boardwalk secrets set");
    expect(out).toContain("API_KEY");
  });

  it("lists built-in + registry templates when the name is unknown", async () => {
    let caught: unknown;
    try {
      await runInit(
        { dir: join(dir, "x"), template: "nope" },
        { log: () => undefined, fetchImpl: registryFetch(REMOTE_FILES), env: ENV },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({
      message: expect.stringContaining("Unknown template"),
      hint: expect.stringContaining("hello, remote-digest"),
    });
  });

  it("errors actionably when the registry is unreachable", async () => {
    await expect(
      runInit(
        { dir: join(dir, "x"), template: "anything" },
        { log: () => undefined, fetchImpl: registryFetch({}), env: ENV },
      ),
    ).rejects.toThrow(/template registry/);
  });

  it("rejects unsafe file paths from a registry", async () => {
    const evil = {
      "/registry.json": JSON.stringify({
        templates: [{ name: "evil", description: "d", secrets: [], files: ["../../escape.ts"] }],
      }),
    };
    await expect(
      runInit(
        { dir: join(dir, "x"), template: "evil" },
        { log: () => undefined, fetchImpl: registryFetch(evil), env: ENV },
      ),
    ).rejects.toThrow(/unsafe file path/);
  });

  it("errors when a listed file 404s", async () => {
    const partial = { ...REMOTE_FILES };
    delete partial["/templates/remote-digest/lib/util.ts"];
    await expect(
      runInit(
        { dir: join(dir, "x"), template: "remote-digest" },
        { log: () => undefined, fetchImpl: registryFetch(partial), env: ENV },
      ),
    ).rejects.toThrow(/lib\/util\.ts/);
  });
});

describe("workflowSlugFor", () => {
  it("kebab-cases the directory basename into a legal slug", () => {
    expect(workflowSlugFor("/tmp/My Cool_Workflow!")).toBe("my-cool-workflow");
  });

  it("falls back when nothing legal survives", () => {
    expect(workflowSlugFor("/tmp/算法")).toBe("my-workflow");
  });
});
