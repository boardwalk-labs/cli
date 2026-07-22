# Contributing to @boardwalk-labs/cli

Thanks for improving the front door. The CLI is UX plus a thin platform client — contracts live in
[`@boardwalk-labs/workflow`](https://github.com/boardwalk-labs/sdk-typescript), engine behavior in
`@boardwalk-labs/engine`; if your change is really one of those, it goes there.

## Ground rules

- **Spec before code.** [`SPEC.md`](./SPEC.md) describes every command and flag; PR the spec
  change alongside a behavior change.
- **Startup budget:** `boardwalk --help` stays under 300ms. Command bodies are lazy-imported;
  nothing heavy loads at parse time. If you add a dependency, prove it doesn't load on `--help`.
- **Secrets never print.** Not in output, not in errors, not in `--verbose`. Tests assert this;
  keep them passing.
- **Errors are actionable.** User-facing failures throw `CliError` with a message and (usually)
  a hint that names the fix. Stack traces are for bugs, not for expected failures.
- **Platform calls use only documented public endpoints.** If a capability isn't in the public
  API, the API grows first — the CLI never reaches around it.

## Workflow

```sh
pnpm install
pnpm test          # vitest — fast, no network (fetch is injected everywhere)
pnpm lint
pnpm typecheck
pnpm format
pnpm build         # → dist/, run via ./bin/boardwalk.js
pnpm boardwalk -- dev ./index.ts   # run from source via tsx
```

All gates must pass; CI runs exactly these plus `npm pack --dry-run`. Every behavior change
ships with tests in the same PR — command-level tests inject `fetchImpl`/`log` rather than
hitting the network or asserting on stdout globals.

## Reporting

Bugs and proposals via GitHub issues (templates provided). Security reports: see
[SECURITY.md](./SECURITY.md) — never a public issue.
