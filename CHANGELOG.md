# Changelog

Notable changes to `@boardwalk-labs/cli`. Pre-1.0, changes ship as patch releases.

## Unreleased

### Added

- **`boardwalk runs <id> --logs`** — print a run's event log (the same lifecycle / phase / output
  frames the dashboard shows), so you can see what a run actually did from the terminal. Channel
  selection matches `dev`: `--stream <channels>` or `--verbose` (which surfaces agent turns + every
  tool call).
- **`boardwalk runs <id> --follow`** — live-tail a run over SSE until it finishes, then exit. Resumes
  by cursor and confirms terminal via the events snapshot, so it ends cleanly even when the stream
  closes without a final status frame. Ctrl-C aborts.
- **`boardwalk runs --workflow <id|slug>`** — scope the runs list to a single workflow.
- **`boardwalk workflows`** — inspect the org's workflows: `list` (default), `show <id|slug>` (the
  manifest projection + version history), and `delete <id|slug>` (guarded behind `--yes`). Accepts a
  workflow id (a ULID, as in a dashboard URL) or a slug.
- **`boardwalk webhook <id|slug>`**: show a workflow's inbound webhook URL and auth mode, or
  `--rotate` to regenerate the secret and reveal the full working URL once. For `token` auth the URL
  embeds the secret (paste it straight into Linear, GitHub, or Stripe); for `signature` auth it
  reveals the HMAC signing key. `--rotate` needs an elevated login.
- **`boardwalk secrets`** — manage the org's secrets: `list` (names/scope/kind/last4 — VALUES are
  never displayed, they can't be read), `set <name>` (value from stdin, `--from-file`, or `--value`),
  and `delete <name>`. Writes need an elevated login (below).
- **`boardwalk inference`** — manage BYO inference providers (the `agent({ provider })` endpoints):
  `list`, `add <name> --source <…>` (with `--base-url` / `--region` / `--api-key`), and
  `delete <name>`. Writes need an elevated login.
- **`boardwalk login --scopes admin`** — an opt-in ELEVATED session carrying the org-admin write
  scopes (secrets, inference providers, workflow delete). The default `boardwalk login` stays
  least-privilege (read + deploy + run); you must be an org admin for the elevated session to take
  effect, and credential-minting / member admin are still off-limits to any CLI token.

### Changed

- **The API host now follows your stored login.** After `boardwalk login` against a dev / self-host
  stack, every authenticated command targets THAT stack automatically — no need to re-export
  `BOARDWALK_API_URL` on each call. An explicit `BOARDWALK_API_URL` / `BOARDWALK_API_DOMAIN` still
  wins; otherwise the session's own API origin is used, falling back to the prod default. `boardwalk
status` labels the host source (`session` vs the env var vs `default`).

## 0.1.13

### Changed

- **`boardwalk dev` now feeds the package's bundled `AGENTS.md` + skills to the engine.** When you
  `dev` a workflow **package directory**, the CLI collects the package-root `AGENTS.md` (the author's
  standing instructions) and `skills/<name>.md` from the SAME source `boardwalk deploy` ships in the
  artifact, and hands them to the embedded engine — so a bundled `AGENTS.md`/skills behave locally
  exactly as they do on the hosted platform. (A single program file ships none, matching `deploy`.)
- Requires `@boardwalk-labs/engine@^0.1.10` — `dev` now also picks up the engine's default-on
  built-in coding tools, LSP diagnostics, context compaction, and two-tier `AGENTS.md` loading, so
  `boardwalk dev` matches the server and hosted engines far more closely.

## 0.1.12

### Added

- **`boardwalk status`** — a one-stop diagnostic: the resolved API host (and which env var set it,
  so "am I on dev, prod, or my self-host?" always has an answer), your login state **live-verified**
  against `GET /v1/me` (proves the credential actually works and names the account + orgs), and the
  project link for the current directory. Degrades gracefully — host + local auth still print when
  offline or logged out. Exits non-zero when there's no usable credential or the server rejected it,
  so it's scriptable. (`whoami` stays the quick local check.)

## 0.1.8

### Added

- **`boardwalk usage`** — your org's runs, compute, tokens, available credit, autonomy (share of
  runs that ran unattended), and prompt-cache hit rate over a window, plus the heaviest models and
  workflows by token volume. `--days <n>` sets the window, `--json` prints the raw summary, and the
  org resolves from `--org` or the linked project.
- **`boardwalk runs [runId]`** — list your org's recent runs as a compact table (id, workflow,
  status, trigger, age, duration), or pass a run id to show that run's detail (status, timings,
  duration, tokens, and the curated error for a failed run). `--status` / `--limit` filter the list;
  `--json` prints the raw response. Detail mode resolves the org from the run id, so no `--org` is
  needed.

## 0.1.4

### Added

- **`boardwalk dev` uses Boardwalk managed inference for `agent()`.** After `boardwalk login`, an
  `agent()` call that names no provider just works — `dev` mints a short-lived, inference-only key
  (scoped to the gateway, with a default spend cap) for the resolved org, caches it, and injects it
  for the embedded engine. No keys to paste; a user-set `BOARDWALK_API_KEY` is always respected, and
  a logged-out / agent-free run is unaffected. New `--org` (which org to bill, else the project
  link's org) and `--token` flags.

## 0.1.3

### Added

- **`boardwalk build <file> [--out <path>]`** — bundle a workflow to one deployable `.mjs`
  (`@boardwalk-labs/workflow` left external, `meta` intact). This is what a self-hosted
  `boardwalk-server` loads from its `BOARDWALK_WORKFLOWS_DIR`: `boardwalk build` → drop the file
  in the dir → `docker run`. Default output is `<workflow-name>.mjs`.

## 0.1.2

### Changed

- **`boardwalk dev` now runs on `@boardwalk-labs/engine`.** It hands the whole run to the engine
  in embedded mode, so `agent()` and `workflows.call()` work locally — the same run semantics
  (hold-and-pay `sleep`, captured output, crash-restart, secret resolution from `.env`) as the
  server and hosted engines. Same flags and frames as before. Adds a dependency on
  `@boardwalk-labs/engine`.
- Ctrl-C cancels the in-flight run cooperatively, then exits 130.

### Fixed

- `--version` reads from `package.json` (was hardcoded and had drifted).
- `boardwalk login` creates its config directory correctly on Windows (`node:path` `dirname`
  instead of a `/`-only split).

## 0.1.1

- Provenance/packaging fixes; `--help` text polish.

## 0.1.0

Initial public release: `init` / `dev` / `check` / `login` / `logout` / `whoami` / `deploy` /
`run` / `cancel`, project linking, and the platform API client.
