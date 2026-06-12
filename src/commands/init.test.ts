import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, workflowNameFor } from "./init.js";
import { extractValidatedManifest } from "../manifest.js";

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
      files: ["index.ts", "package.json", ".env.example", "lib/util.ts"],
    },
  ],
});

const REMOTE_FILES: Record<string, string> = {
  "/registry.json": REGISTRY,
  "/templates/remote-digest/index.ts": `export const meta = { name: "remote-digest", triggers: [{ kind: "manual" }] };
export default async function run(): Promise<void> {}`,
  "/templates/remote-digest/package.json": `{ "name": "remote-digest", "private": true }`,
  "/templates/remote-digest/.env.example": "API_KEY=…\n",
  "/templates/remote-digest/lib/util.ts": "export const x = 1;\n",
};

const ENV = { BOARDWALK_TEMPLATES_URL: "https://templates.test" };

describe("runInit (built-in template)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bw-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds hello with a manifest-valid program, offline", async () => {
    const target = join(dir, "my-digest");
    const lines: string[] = [];
    await runInit(
      { dir: target, template: "hello" },
      {
        log: (l) => lines.push(l),
        fetchImpl: (() => {
          throw new Error("built-in templates must not hit the network");
        }) as unknown as typeof fetch,
      },
    );

    for (const f of ["index.ts", "package.json", ".env.example", ".gitignore"]) {
      expect(existsSync(join(target, f)), f).toBe(true);
    }
    const manifest = extractValidatedManifest(readFileSync(join(target, "index.ts"), "utf8"));
    expect(manifest.name).toBe("my-digest");
    expect(lines.join("\n")).toContain('scaffolded "my-digest"');
  });

  it("refuses to overwrite existing files", async () => {
    const target = join(dir, "taken");
    await runInit({ dir: target, template: "hello" }, { log: () => undefined });
    await expect(
      runInit({ dir: target, template: "hello" }, { log: () => undefined }),
    ).rejects.toThrow(/already exists/);
  });

  it("aborts before writing anything when one target exists", async () => {
    const target = join(dir, "partial");
    await runInit({ dir: target, template: "hello" }, { log: () => undefined });
    rmSync(join(target, "package.json"));
    writeFileSync(join(target, ".gitignore"), "mine\n");
    await expect(
      runInit({ dir: target, template: "hello" }, { log: () => undefined }),
    ).rejects.toThrow(/already exists/);
    expect(existsSync(join(target, "package.json"))).toBe(false);
    expect(readFileSync(join(target, ".gitignore"), "utf8")).toBe("mine\n");
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
    const manifest = extractValidatedManifest(readFileSync(join(target, "index.ts"), "utf8"));
    expect(manifest.name).toBe("remote-digest"); // verbatim — no {{name}} substitution
    const out = lines.join("\n");
    expect(out).toContain("cp .env.example .env");
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

describe("workflowNameFor", () => {
  it("kebab-cases the directory basename into a legal name", () => {
    expect(workflowNameFor("/tmp/My Cool_Workflow!")).toBe("my-cool-workflow");
  });

  it("falls back when nothing legal survives", () => {
    expect(workflowNameFor("/tmp/算法")).toBe("my-workflow");
  });
});
