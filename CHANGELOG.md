# Changelog

Notable changes to `@boardwalk-labs/cli`. Pre-1.0, changes ship as patch releases.

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
