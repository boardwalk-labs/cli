# SPEC — `boardwalk-cli` (`@boardwalk/cli`)

> The front door: author, validate, run locally, and deploy workflows. MIT. Public in **Phase 1**.
>
> Governing context: root [`MASTER_SPEC.md`](../MASTER_SPEC.md) §3 (engines), §6.1 (Cloud only via public API).

## 1. Purpose

One binary, `boardwalk`, covering the full author journey: `init` (start from a template) → `dev` (run it now, locally, no account) → `check` (validate) → `login`/`deploy`/`run` (Boardwalk Cloud). The CLI contains UX and a Cloud API client — engine logic lives in `@boardwalk/engine`, contracts in `@boardwalk/workflow`.

## 2. Commands (v1)

| Command | Args / flags | Behavior |
|---|---|---|
| `init [dir]` | `--template <name>` (default: an interactive picker) | Scaffold a workflow project from a `boardwalk-examples` template: program file, `package.json`, `.env.example`, `.gitignore` (covers `.env`, `.boardwalk/`) |
| `dev <file>` | `--input <json>`, `--env-file <path>` (default `.env`), `--verbose`, `--stream <channels>` | **Run the workflow now, locally, no account.** Derives the manifest, validates, spawns the run via `@boardwalk/engine`, streams the run-event log, exits with the run's status (0 completed / 1 failed / 130 cancelled) |
| `check <file>` | — | Validate program + manifest locally. No auth, no network |
| `login` | `--token <key>` | Browser PKCE flow against the configured issuer; `--token` stores an API key (`bwk_…`) instead. Precedence: `--token` > `BOARDWALK_API_KEY` > stored session |
| `logout` / `whoami` | — | Session management |
| `deploy <file>` | `--org <slug>`, `--dry-run`, `--bundle`, `--token` | Deploy to Boardwalk Cloud; creates/updates the linked workflow, prints the new version. `--bundle` esbuild-bundles dependencies (automatic for directories) |
| `run <file>` | `--org`, `--input <json>`, `--bundle`, `--no-wait`, `--verbose`, `--stream <channels>`, `--token` | Deploy-and-trigger against Cloud; default waits, streaming the same event renderer as `dev` |
| `cancel <runId>` | `--token` | Cancel a Cloud run |

`<file>` is a workflow program file or a package directory throughout.

**Not in the v1 public surface:** the eval runner command (pre-release; may return in a later minor).

## 3. Configuration

- **Env vars:** `BOARDWALK_API_URL` (full REST URL) or `BOARDWALK_API_DOMAIN` (hostname → `https://<domain>`; the self-host knob), `BOARDWALK_API_KEY`, `BOARDWALK_ISSUER_URL`, `BOARDWALK_OAUTH_CLIENT_ID` (default `boardwalk-cli`), `BOARDWALK_OAUTH_PORT` (default 53682), `BOARDWALK_CONFIG_DIR` (credentials location, XDG default).
- **Project link:** `.boardwalk/project.json` — `{ orgSlug, workflowId }` — written on first deploy, gitignored; makes the workflow identity rename-safe and `--org` optional thereafter.
- **Issuer-agnostic:** the CLI never names an auth vendor; it speaks OAuth PKCE to whatever issuer the API advertises.

## 4. `dev` — the local run loop (v1 scope)

1. Load `.env` (or `--env-file`) into the run's secret/env resolution; never print values.
2. Derive + validate the manifest (`parseMeta`); fail with precise, friendly errors before anything runs.
3. Spawn the run through `@boardwalk/engine`'s embedded mode (one run, in-process supervisor, exit on terminal status).
4. Render the event stream live, honoring the **channel subscription** (SDK kind→channel mapping, MASTER_SPEC §2.5): default = `lifecycle + phase + output` (plus errors — quiet, readable); `--stream <channels>` picks channels explicitly (e.g. `--stream output` for result-only, pipe-friendly); `--verbose` subscribes to everything (agent turns streamed, tool calls, captured stdout/stderr, token usage + duration summary). One renderer, channel-driven — the same flags mean the same thing on `dev` and `run --wait`.
5. Missing secret → error naming the variable and pointing at `.env`. Omitted `agent()` model → error naming the config key for a local default model.

Deliberately absent from `dev` v1: cron/webhook listening, run history, daemon mode. Production scheduling = `deploy` or the self-hosted server (MASTER_SPEC §3).

## 5. Cloud API client

- Generated types from the published OpenAPI spec; hand-rolled thin client (no codegen frameworks).
- Talks **only** to documented public endpoints — if a capability isn't in the public API, the API grows first (MASTER_SPEC §6.1).
- Bearer auth (session token or API key); friendly mapping of 401/403/404/422 to actionable messages.

## 6. Internal architecture

```
src/
  index.ts        — arg parsing, command dispatch (lazy-imports each command)
  commands/       — one module per command
  config.ts       — env + credentials resolution
  project.ts      — .boardwalk link file
  api/            — Cloud client + OpenAPI types
  render/         — the event-stream renderer (shared by dev and run --wait)
  bundle.ts       — esbuild integration
```

- **Startup budget: `boardwalk --help` < 300ms** (CODE_QUALITY §4.1). Nothing heavy (engine, esbuild, API client) is imported until its command runs.
- Renderer is TTY-aware: rich output on TTY, plain line-oriented output when piped.

## 7. Testing

- Command-level integration tests against a fake Cloud API server and a temp project dir (login token flow, deploy plan, project-link lifecycle, exit codes).
- `dev` end-to-end on fixture workflows (success, failure, missing secret, budget breach) asserting exit codes and rendered frames.
- Config precedence matrix tests; `.env` loading; secret non-printing.

## 8. Ready to go public when

1. All §2 commands work against Boardwalk Cloud's public API and a published `@boardwalk/engine` (interim: `dev` may ship one release behind a feature flag if the engine isn't published yet — `init`/`check`/`login`/`deploy`/`run` carry Phase 1 on their own).
2. `npm i -g @boardwalk/cli` on a clean machine: `init` → `dev` (or `check`) → `login` → `deploy` → green run, documented in the README quickstart.
3. Startup budget met; no secrets in any output; publication checklist (MASTER_SPEC §8) passes.
