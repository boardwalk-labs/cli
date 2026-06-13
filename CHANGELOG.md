# Changelog

Notable changes to `@boardwalk-labs/cli`. Pre-1.0, changes ship as patch releases.

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
