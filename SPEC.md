# SPEC — `cli` (`@boardwalk-labs/cli`)

> The front door: author, validate, run locally, and deploy workflows. MIT. Public in **Phase 1**.
>
> Governing context: root [`MASTER_SPEC.md`](../MASTER_SPEC.md) §3 (engines), §6.1 (the platform only via public API).

## 1. Purpose

One binary, `boardwalk`, covering the full author journey: `init` (start from a template) → `dev` (run it now, locally, no account) → `check` (validate) → `login`/`deploy`/`run` (the Boardwalk platform). The CLI contains UX and a platform API client — engine logic lives in `@boardwalk-labs/engine`, contracts in `@boardwalk-labs/workflow`.

## 2. Commands (v1)

| Command             | Args / flags                                                                                                                                                            | Behavior                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [dir]`        | `--template <name>` (default: the built-in `hello` template)                                                                                                            | Scaffold a workflow project from a `examples` template: program file, `package.json`, `.env.example`, `.gitignore` (covers `.env`, `.boardwalk/`)                                                                            |
| `dev <file>`        | `--input <json>`, `--env <path>` (default `.env`; named `--env` because Node ≥26 intercepts a literal `--env-file` argument itself), `--verbose`, `--stream <channels>` | **Run the workflow now, locally, no account.** Derives the manifest, validates, spawns the run via `@boardwalk-labs/engine`, streams the run-event log, exits with the run's status (0 completed / 1 failed / 130 cancelled) |
| `check <file>`      | —                                                                                                                                                                       | Validate program + manifest locally. No auth, no network                                                                                                                                                                     |
| `login`             | `--token <key>`                                                                                                                                                         | Browser PKCE flow against the configured issuer; `--token` stores an API key (`bwk_…`) instead. Precedence: `--token` > `BOARDWALK_API_KEY` > stored session                                                                 |
| `logout` / `whoami` | —                                                                                                                                                                       | Session management                                                                                                                                                                                                           |
| `deploy <file>`     | `--org <slug>`, `--dry-run`, `--token`                                                                                                                                  | Deploy to the Boardwalk platform; creates/updates the linked workflow, prints the new version. Dependencies are esbuild-bundled into the uploaded source automatically                                                       |
| `run <file>`        | `--org`, `--input <json>`, `--no-wait`, `--token`                                                                                                                       | Deploy-and-trigger against the platform; default waits, polling the run to a terminal status (v0.1 — no live streaming yet; use `dev` for the streamed log)                                                                  |
| `cancel <runId>`    | `--token`                                                                                                                                                               | Cancel a hosted run                                                                                                                                                                                                          |

`<file>` is a workflow program file or a package directory throughout.

**Not in the v1 public surface:** the eval runner command (pre-release; may return in a later minor).

## 3. Configuration

- **Env vars:** `BOARDWALK_API_URL` (full REST URL) or `BOARDWALK_API_DOMAIN` (hostname → `https://<domain>`; the self-host knob), `BOARDWALK_API_KEY`, `BOARDWALK_ISSUER_URL`, `BOARDWALK_OAUTH_CLIENT_ID` (default `boardwalk-cli`), `BOARDWALK_OAUTH_PORT` (default 53682), `BOARDWALK_CONFIG_DIR` (credentials location, XDG default).
- **Project link:** `.boardwalk/project.json` — `{ orgSlug, workflowId }` — written on first deploy, gitignored; makes the workflow identity rename-safe and `--org` optional thereafter.
- **Issuer-agnostic:** the CLI never names an auth vendor; it speaks OAuth PKCE to whatever issuer the API advertises.

## 4. `dev` — the local run loop (v1 scope)

1. Load `.env` (or `--env <path>`) into the run's secret/env resolution; never print values.
2. Derive + validate the manifest (`extractValidatedManifest`, over the SDK's `/extract` + schema); fail with precise, friendly errors before anything runs.
3. Spawn the run through `@boardwalk-labs/engine`'s embedded mode (one run, in-process supervisor, exit on terminal status).
4. Render the event stream live, honoring the **channel subscription** (SDK kind→channel mapping, MASTER_SPEC §2.5): default = `lifecycle + phase + output` (plus errors — quiet, readable); `--stream <channels>` picks channels explicitly (e.g. `--stream output` for result-only, pipe-friendly); `--verbose` subscribes to everything (agent turns streamed, tool calls, captured stdout/stderr, token usage + duration summary). One renderer, channel-driven. (These flags are on `dev`; `run` polls to a terminal status in v0.1 and does not stream.)
5. Missing secret → error naming the variable and pointing at `.env`. Omitted `agent()` model → error naming the config key for a local default model.

Deliberately absent from `dev` v1: cron/webhook listening, run history, daemon mode. Production scheduling = `deploy` or the self-hosted server (MASTER_SPEC §3).

### 4.1 v0.1 implementation status (pre-`@boardwalk-labs/engine`)

`dev` ships now with a **minimal built-in host** instead of step 3's embedded engine (the §8.1
interim): the program is esbuild-bundled with `@boardwalk-labs/workflow` resolved to the CLI's own
installed copy (one module instance ⇒ the host singleton is shared) and executed in-process.
Working today: manifest validation, `.env` secrets (fail-closed against `meta.secrets`), real
`sleep`, `Phase()` / `output()` frames, artifacts under `.bw-runs/<runId>/`, channel-filtered
rendering, exit codes (0 / 1 / 130 on Ctrl-C). Not yet (each fails with a clear pointer, never
silently): `agent()`, `workflows.call()`; program stdout/stderr passes straight through to the
terminal rather than being captured as `program_output` events. Swapping the built-in host for
`@boardwalk-labs/engine` embedded mode removes those gaps without changing any flag or frame.

## 5. platform API client

- Hand-rolled thin client (no codegen frameworks) with runtime shape guards on every response;
  generated **types** from the published OpenAPI spec layer in once that spec is published.
- Talks **only** to documented public endpoints — if a capability isn't in the public API, the API grows first (MASTER_SPEC §6.1).
- Bearer auth (session token or API key); friendly mapping of 401/403/404/422 to actionable messages.
- Deploys are artifact-based: deterministic content-addressed tarball (bundled entry + sourcemap +
  original source + package assets), uploaded via a presigned PUT, finalized by digest reference.
- v0.1: `run --wait` polls run status to terminal; live event streaming (the same renderer as
  `dev`, same `--verbose`/`--stream` flags) lands when the public run-events endpoint ships.

## 6. Internal architecture

```
src/
  index.ts        — arg parsing, command dispatch (lazy-imports each command body)
  commands/       — one module per command (init, dev, check, session, deploy, run, cancel)
  config.ts       — env-derived configuration
  credentials.ts  — the on-disk session store (0600)
  auth/           — PKCE flow, OAuth discovery, token resolution/refresh
  project.ts      — .boardwalk link file
  client.ts       — the platform API client
  deployment.ts   — shared deploy-with-link logic
  artifact.ts     — content-addressed program artifact builder
  bundle.ts       — esbuild integration (deploy externals + dev shared-SDK resolve)
  manifest.ts     — CliError wrappers over the SDK's /extract
  dev/            — the minimal built-in dev host (§4.1)
  render/         — the channel-filtered event-stream renderer (used by dev)
```

- **Startup budget: `boardwalk --help` < 300ms** (CODE_QUALITY §4.1). Nothing heavy (the dev host, esbuild, the SDK extractor, the API client) is imported until its command runs. Measured ~80ms.
- Renderer is line-oriented and pipe-friendly; agent text streams raw, everything else is one prefixed line. (Richer TTY treatment can layer on without changing the frames.)

## 7. Testing

- Command-level tests with an injected fetch + temp project dirs (login token flow, deploy plan, project-link lifecycle, cancel statuses).
- `dev` end-to-end on fixture workflows (success, program throw, invalid manifest, missing env file, missing/undeclared secret, `--stream output` piping, agent() pointer) asserting exit behavior and rendered frames.
- Renderer/channel-flag matrix; manifest extraction + validation fixtures; artifact determinism; config precedence; `.env` loading; secret non-printing.

## 8. Ready to go public when

1. All §2 commands work against the Boardwalk platform's public API and a published `@boardwalk-labs/engine` (interim: `dev` may ship one release behind a feature flag if the engine isn't published yet — `init`/`check`/`login`/`deploy`/`run` carry Phase 1 on their own).
2. `npm i -g @boardwalk-labs/cli` on a clean machine: `init` → `dev` (or `check`) → `login` → `deploy` → green run, documented in the README quickstart.
3. Startup budget met; no secrets in any output; publication checklist (MASTER_SPEC §8) passes.
