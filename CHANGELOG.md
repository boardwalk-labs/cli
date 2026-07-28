# Changelog

Notable changes to `@boardwalk-labs/cli`. Pre-1.0, changes ship as patch releases.

## 0.3.17

### Fixed

- The command summary in `--help` still advertised the removed
  `boardwalk webhook <ref> [--rotate]`. It now names `boardwalk webhooks`.

## 0.3.16

### Changed — `boardwalk webhooks` replaces `boardwalk webhook <ref>`

A webhook is now an org-level endpoint rather than a property of one workflow (workflow SDK 0.3.7),
so the command follows:

```
boardwalk webhooks                     # name, URL, verification (never secrets)
boardwalk webhooks create <name>       # create one; the signing secret is shown ONCE
boardwalk webhooks rotate <name>       # new secret, shown ONCE; the old one stops working
boardwalk webhooks delete <name> --yes
```

Create it once, point a sender at its URL, then attach any number of workflows with
`{ "kind": "webhook", "name": "<name>" }` in their descriptor triggers — **every attached workflow
runs on every delivery**. To split events between workflows, create a second webhook and choose
which events go where on the sender's side.

For a sender that owns its signing key (Stripe, Slack, Sentry, PagerDuty, anything Standard
Webhooks), pass it with `--secret` — or `--secret -` to read stdin so it stays out of shell history.

`boardwalk webhook <id|slug>` is **removed**, along with the descriptor's `auth` field: how a
delivery is verified is a property of the endpoint, chosen where the endpoint is created.

## 0.3.13

### Added — `boardwalk check` accepts the `linear` trigger kind

Workflow SDK 0.3.4: a descriptor may declare `{ "kind": "linear", "event": "issue.created" }` with
the semantic vocabulary (`issue.created`, `issue.status_changed`, `issue.commented`). No URL, no
secret. Connect the workspace via the web console (Connections -> Triggers -> Linear) and
Boardwalk creates and verifies the workspace webhook itself.

## 0.3.12

### Added — `boardwalk check` accepts the `github` trigger kind

Workflow SDK 0.3.3: a descriptor may declare
`{ "kind": "github", "event": "pr.merged", "repos": ["acme/api"] }` with the semantic event
vocabulary (`pr.opened`, `pr.merged`, `issue.opened`, `issue.commented`, `ci.completed`). No URL,
no secret — events arrive through the org's GitHub connection, filtered and deduped platform-side
before any run is created. Connect via the web console (Connections → Connect GitHub).

## 0.3.11

### Changed — `runner start` converges on "enrolled and online"

It used to reuse whatever identity was on disk, unconditionally. That hidden state outlived
upgrades, which is what made a rejected runner a dead end: the saved credential could not be
replaced by anything the command did, so 0.3.9 and 0.3.10 had to ship recovery tooling for a
state that should not have been reachable.

Now a saved credential the control plane refuses (401) is treated as what it is — stale local
state — and the CLI, which is already holding the org credentials, discards it and enrolls again,
once. A refused DAEMON (403) is not retried, because re-registering the same binary would be
refused identically; it exits naming the upgrade instead.

Ships `@boardwalk-labs/runner` 0.3.17, which declares its wire revision on every poll and claim
rather than once at registration — so the control plane judges what is actually running, and
upgrading a runner is by itself enough to clear a compatibility refusal.

## 0.3.10

### Fixed — `runner remove` rescues an already-deleted runner

0.3.9's recovery path had a hole in exactly the case it was written for. A runner whose token was
revoked is already gone from the control plane, so the `runner remove` it tells you to run answered
404 and threw — before clearing the local identity, leaving the machine stuck on the dead one.
A 404 now counts as removed: absent server-side is the state the command is trying to reach.

## 0.3.9

### Fixed — a rejected runner identity is now escapable

0.3.8 stopped the CLI from enrolling runners the control plane would refuse, but anything already
holding a stale identity stayed stuck: the version a runner is judged on is written at registration
and never refreshed, and `runner start` reuses the saved identity file rather than registering
again — so the control plane's own advice ("upgrade the daemon and re-register") could not work.

- **`runner remove` now clears this machine's saved identity for the runner it deregisters.**
  Leaving it behind meant the next `runner start` reused a credential the control plane had already
  destroyed. Only a matching identity is dropped — removing another box's runner touches nothing
  locally.
- **A refused runner now fails with the recovery.** Instead of the daemon's raw 403 repeating
  forever, the command exits naming both commands that fix it.
- Ships `@boardwalk-labs/runner` 0.3.16, where the daemon stops on a rejected identity rather than
  retrying it forever, and only claims to be `online` after a poll the control plane accepts.

## 0.3.8

### Fixed — `boardwalk runner start` could never bring a runner online

Registration never declared the runner's version. The control plane gates BOTH poll and claim on
the version stored at registration (`MIN_RUNNER_VERSION`), and nothing refreshes it afterwards, so
a freshly enrolled runner reported `(none)` and every poll came back 403 — self-hosted runners were
unusable on any org, not merely stale ones. Both enrollment paths now send it: `version` on the
one-step management registration, `runner_version` on the two-step fleet redemption.

The failure was quiet in the way that costs the most time. The daemon printed
`Runner <name> online in pool 'default'. Waiting for runs...` and then warned in a loop forever,
`runner list` showed the runner as `idle`, and the 403's own advice — "Upgrade the boardwalk runner
daemon and re-register" — could not work, because `runner start` reuses the saved identity file and
never re-registers. (Fail-fast on that 403 is a `@boardwalk-labs/runner` change, not shipped here.)

### Fixed — a Python build can no longer ship native code for the wrong machine

- **`check` / `build` / `deploy` now refuse a dependency layer holding a native extension built for
  anything but the hosted runner.** The build resolves wheels for the runner's CPython and platform,
  not yours — but a package with no matching wheel makes uv fall back to building its sdist _for the
  build machine_, and that layer packed and uploaded clean, then failed only when a run imported it.
  Observed with an outdated uv, which couldn't see numpy's wheels and quietly compiled macOS
  binaries into a Linux artifact.

  The check reads the ABI tag off the emitted `.so` files, rather than passing uv `--only-binary`,
  so a source build that emits no native code (any pure-Python package, which many publish as an
  sdist only) still works exactly as before. `foo.abi3.so` and bundled libraries like
  `libscipy_openblas-….so` are skipped — neither is tied to an interpreter version.

  The error names the offending tag and file, and points at uv:

  ```
  This package's dependencies built native extensions for .cpython-313-darwin.so, but hosted
  runs load .cpython-313-x86_64-linux-gnu.so (CPython 3.13 on x86_64-unknown-linux-gnu) — they
  cannot be imported on the runner. First of 19: numpy/_core/_multiarray_umath.cpython-313-darwin.so.
  ```

## 0.3.7

### Changed — `run` and `deploy` split (BREAKING)

- **`boardwalk run <workflow>` runs a DEPLOYED workflow, named by slug or id.** It reads nothing
  from disk: no package, no build, no deploy, no project link. Running is a control-plane
  operation, so it now works from any directory on any machine that has a login — you no longer
  need a local copy of a workflow to run it, which was previously impossible from the CLI at all.
  Re-running with a different `--input` no longer redeploys unchanged code.

  ```sh
  boardwalk run nightly-summary --input '{"since":"2026-01-01"}'
  boardwalk run 01KV4SMQ0JFCNH9X4VQVW10STZ        # by id, as in a dashboard URL
  ```

  It prints the version it is firing and how long ago that was deployed, so local edits you forgot
  to ship are visible rather than silent. `--org` is needed only when your login covers more than
  one org.

- **`boardwalk run <dir>` is gone.** It used to deploy the directory and then trigger it, which
  meant every run cut a new version and paid a full server-side schema derivation. A path-shaped
  argument now fails with a pointer to the replacement instead of doing something surprising.

- **`boardwalk deploy <dir> --run` is the authoring loop** — deploy, then fire the version just
  shipped, reporting exactly as `run` does. It takes `--input`, `--environment`, and `--no-wait`.
  Without `--run`, `deploy` only deploys.

## 0.3.6

### Changed

- **`workflows delete` works from a plain `boardwalk login`.** The control plane moved
  `workflow:delete` into the default CLI scope set, so deleting a workflow no longer needs
  `boardwalk login --scopes admin`. It stays gated on the admin org role, exactly as on the web.
  Elevated is now precisely what it says: secrets and inference providers.

  A session's scopes are frozen when it is authorized and carried through every refresh, so a login
  created before this change keeps failing until you run `boardwalk login` again. That denial now
  explains itself instead of surfacing a raw scope string.

- **The OAuth callback page reads "Go build some things."**

### Requires

- A control plane carrying the scope change. Against an older Boardwalk, `workflows delete` still
  needs `boardwalk login --scopes admin` — the failure hint names that fallback.

## 0.3.5

### Fixed

- **`check` and `deploy` rejected `workspace.key`.** The CLI validates a descriptor locally against
  its own pinned `@boardwalk-labs/workflow`, which was still 0.3.1 — so the field the control plane
  had just learned to accept was refused at the authoring surface, making the feature unusable from
  the CLI. Pinned to 0.3.2. Found by deploying a keyed workflow end-to-end rather than trusting the
  unit tests.

- **`runner start` launched a daemon below the control plane's floor.** The bundled
  `@boardwalk-labs/runner` was pinned `^0.2.0`, which cannot resolve past 0.2.x, while
  `MIN_RUNNER_VERSION` is 0.3.10 — so a CLI-started self-hosted runner was refused at claim with
  nothing to upgrade to. This predates the current release (the floor was already 0.2.1), but the
  workspace-storage rewrite widened the gap: a 0.2.x daemon speaks a storage format the control plane
  no longer serves endpoints for. Pinned to `^0.3.10`.

## 0.3.4

### Changed

- **`boardwalk workspace` addresses a scope explicitly.** A workflow's persistent workspace is scoped
  by environment AND by the new `workspace.key` (an author-set template scoping state per customer,
  repo, or tenant), so `workspace show` gains a key column and `workspace reset` gains `--key`.

  `reset` now resolves the flags to exactly one scope and clears that one by its id. Two behaviours
  changed on purpose:

  - There is no longer a request shape that clears a scope you did not name. Previously the flags
    defaulted to the unkeyed scope, which — once keys exist — reports success while every keyed scope
    survives.
  - If the addressed scope holds nothing **and other scopes do**, reset refuses and lists them rather
    than reporting a clean "nothing to reset". You asked to clear state, there is state, and you named
    the wrong scope; succeeding quietly is how the wrong thing survives.

  Requires a control plane new enough to return scope ids; against an older one, reset says so instead
  of guessing.

## Unreleased

### Added

- **Python workflow packages build end-to-end** (`init --python`, `check`, `build`, `deploy`). A
  package whose resolved entry is a `.py` file — the descriptor's `entry`, or `main.py` at the
  package root when no TS entry exists — builds down the Python path: no esbuild bundle and no
  types harvest. The author layer is the `.py` source tree under `.bw-src/` (never `.venv`,
  `__pycache__`, `.env*`, or dotfiles) with `pyproject.toml`/`requirements.txt`/`uv.lock` riding
  along (Python has no bundle step, so the dependency declarations are part of the program), plus
  the descriptor verbatim and the unchanged `skills/**` + README + `files` conventions. Declared
  dependencies (`[project].dependencies` in `pyproject.toml`, preferred, or `requirements.txt`)
  are resolved + frozen at build time with `uv` — lockfile-pinned (`uv lock` → `uv export
--frozen`), installed into a temp target, and packed as the machine layer at
  `.bw-machine/site-packages/` (the ratified sibling of `.bw-machine/types/`), cross-targeted to
  the hosted runner's platform (x86_64 Linux, CPython 3.13). Nothing installs on the run hot path
  or into the author's environment; a package with no dependencies builds without uv at all, and
  a missing uv errors with the install command only when resolution is actually needed.
  Byte-compiling (.pyc) is deliberately skipped until the microVM cold-start benchmark decides
  it. `boardwalk init --python` scaffolds the descriptor (`entry: "main.py"`), a pydantic-typed
  `main.py`, a `pyproject.toml` (no dependency on the not-yet-published `boardwalk` PyPI package
  — the SDK ships in the runtime), and a Python `.gitignore`. `check` prints the site-packages
  layer summary and notes that hosted deploys don't accept Python entries until the backend's
  `.py` schema derivation lands.

## 0.2.10

### Fixed

- The release binaries smoke test asserted the removed `dev` command's Bun guard; it now asserts
  the `runner` guard (the surviving Bun-excluded command family). No CLI changes — 0.2.9's binaries
  job failed on this, so the native binaries and the Homebrew formula ship from this release.

## 0.2.9

### Removed

- **`boardwalk dev` is gone.** The local-run command was a third substrate to keep at parity with
  hosted and self-hosted execution, and it was neither offline (managed inference and
  `workflows.call` already required the platform) nor faithful (local secrets, holds, and Python
  skew would each behave "almost" like the platform). Unit-test your workflow as a plain program,
  validate with `boardwalk check`, run it for real with `boardwalk run`; to execute runs on your
  own machine, use a self-hosted runner (`boardwalk runner start`) — the real runtime, not an
  emulation. With it go the `.env.example` scaffold, the cached dev inference keys in
  `credentials.json`, and the CLI's direct `@boardwalk-labs/engine` dependency.

## 0.2.8

### Added

- **`boardwalk setup` — a one-command install wizard.** It logs you in (browser OAuth), detects
  which coding agent you use (Claude Code, Codex, Cursor, OpenCode, OpenClaw), and installs that
  agent's Boardwalk plugin + skills and the control-plane MCP server. The agents with first-class
  installers (Claude Code, Codex) are wired up for you; the rest print an exact recipe. Interactive
  by default, with `--harness`, `--yes`, and `--print-only` for non-interactive and CI use. It never
  touches files in your repo. This is also what the `npx @boardwalk-labs/setup` shim runs.

## 0.2.4

### Added

- **A failed run shows its engine hint** on `boardwalk runs <id>`. A curated failure error can now
  carry an optional one-line `hint` — the actionable pointer an engine validation error attached
  (which field to use, what to type) — printed on its own `Hint` row under `Error`. `--json` emits
  it automatically; the live `--follow` renderer is unchanged (that path needs the SDK type first).
- **`boardwalk init` scaffolds a README.** The built-in `hello` template — the default, and so the
  most common `init` — now ships a `README.md` titled after the workflow, so a new workflow has the
  landing page the dashboard renders instead of the "No README" empty state.

### Changed

- **`--verbose` shows context-compaction passes** in the renderer. The two new SDK 0.2.2 event kinds
  render on the `agent` channel (so they ride `--verbose` / `--stream agent`, not the default view),
  reporting when compaction starts and how many tokens it freed.
- **Homebrew now installs the native binary** (no Node). The tap formula downloads the
  platform-specific single-file executable from the GitHub Release instead of the npm tarball, so
  `brew install boardwalk-labs/tap/boardwalk` no longer depends on Node — and the release's
  brew-smoke-test drops the old npm `--min-release-age` workaround (a binary has no deps).
- Release attaches the binaries only (dropped a stray `index.js.map` sourcemap sidecar).

## 0.2.1

### Added

- **`boardwalk workflows show <ref> --source`** — print the deployed program's source, the code that
  is actually running. Bare for a single-file program (so `> index.ts` redirects cleanly),
  banner-per-file (`// ==> path`) for a package. `show` also names the source files, and `--json`
  now carries them. Previously the API sent the source and the CLI discarded it, so there was no way
  to read your own deployed program from the terminal.

### Changed

- **A package now ships its whole local source tree** in the artifact (under `.bw-src/`), not just
  its entry. Storing only the entry left a dashboard code view showing an `index.ts` importing a
  `./plan.js` it could neither display nor round-trip — and left the platform holding no copy of the
  sibling at all. The tree is rooted at the entry's directory so its relative imports stay
  resolvable; build output, `node_modules`, and dotfiles stay out. The runtime is unchanged: local
  modules are still inlined into the single bundled `index.mjs` the runner imports.

## 0.1.31

### Added

- **Native single-file executables** — the CLI now ships as a Node-free binary compiled with Bun
  (`bun build --compile`), cross-built for macOS (arm64/x64), Linux (x64/x64-baseline/arm64), and
  Windows (x64) and attached to each GitHub Release. Install with
  `curl -fsSL https://raw.githubusercontent.com/boardwalk-labs/cli/main/scripts/install.sh | bash`
  (`scripts/install.sh` detects OS/arch/AVX2) — no Node required. The npm package
  (`@boardwalk-labs/cli`) stays the full Node build; this is an additional distribution channel.
- Under the compiled binary the workflow bundler uses **Bun's native bundler** instead of esbuild
  (whose native child-process binary can't be embedded in a single-file executable); the esbuild
  path is unchanged under Node.

### Changed

- The local-engine commands — `boardwalk dev` and every `boardwalk runner` subcommand — are
  **excluded from the single-file binary** and fail fast with a pointer to the Node build when run
  under Bun. Their dependency graph pulls `@boardwalk-labs/engine` → `node:sqlite`, which Bun doesn't
  implement and eagerly resolves at startup (it would crash _every_ command), so they load via a
  non-static import that Bun's compiler leaves out. The control-plane commands
  (deploy/run/runs/secrets/…) work from the binary; `dev`/`runner` stay on the Node build.

### Fixed

- Release workflow pins `npm@^11.5.1` for publishing (npm 12's provenance path breaks with
  `Cannot find module 'sigstore'`).

## 0.1.30

### Fixed

- `webhook` now renders the real webhook contract: the endpoint URL is bare (the secret is
  **never** in the URL) and verification happens in a header per the trigger's verifier preset —
  `X-Boardwalk-Token`, a custom header, `X-Boardwalk-Signature` HMAC, or the GitHub / Stripe /
  Slack / Linear dialects. Previously the command printed a `…/<token>` URL from the retired
  URL-token design, and `webhook --rotate` on a token-auth trigger printed only the URL —
  discarding the freshly minted secret it had just rotated to. `--rotate` now always reveals the
  secret (show-once) with per-scheme sending guidance, and `--json` carries the new `preset` +
  `header` fields.

## 0.1.27

### Changed

- **Determinism is now enforced.** `deploy`, `run`, and `check` **block** on bare clock/random/uuid
  calls outside a journaled seam (`Date.now` / `new Date()` / `Math.random` / `crypto.randomUUID` /
  `crypto.getRandomValues` / `randomUUID`), which corrupt a run's state on a resume or crash. Fix
  them with the durable `now()` / `random()` / `uuid()` primitives (`@boardwalk-labs/workflow`
  ≥ 0.1.17), or `step.run(...)`, or pass `--allow-nondeterminism` to override. Bare `fetch` stays
  advisory (it does not block), and `build` / `dev` print all determinism warnings advisory.

## 0.1.24

### Fixed

- `login` no longer hangs after printing `✓ Logged in.`. The loopback OAuth callback server now
  forces its sockets shut on teardown (`Connection: close` on the callback response plus
  `closeAllConnections()`), so the browser's parked keep-alive socket can't hold the event loop
  open and the command returns to the shell.
- `runs <id>` and `usage --org <slug>` now show a friendly `No run "…" found.` / `Org "…" not
found.` for an unknown id/slug, instead of leaking the raw `GET /v1/… failed (404)` line.
- `models list` pads sub-dollar prices to a consistent 2+ decimals (`$0.70`, not `$0.7`) while
  keeping sub-cent precision (`$0.035`).

### Changed

- `run` prints the workflow's `output(...)` inline in its result block (read from the run's event
  log, the same source as `runs <id> --logs`) and points at `boardwalk runs <id> --logs`, rather
  than deferring the result to the dashboard.

## 0.1.23

### Changed

- Bump `@boardwalk-labs/workflow` to ^0.1.15 and `@boardwalk-labs/engine` to ^0.1.27, so `check`/
  `dev`/`build` typecheck programs that set `budget.deadline_seconds`.

## 0.1.22

### Changed

- Bump `@boardwalk-labs/workflow` to ^0.1.14 and `@boardwalk-labs/engine` to ^0.1.26, so `check`/
  `deploy`/`dev` accept the new `workflow_run` trigger (run a workflow when another completes).

## 0.1.21

### Added

- Determinism lint: `check`, `build`, `dev`, `deploy`, and `run` now print an advisory warning for
  bare `Date.now` / `Math.random` / `new Date()` / `performance.now` / `fetch` that sit OUTSIDE a
  journaled seam (`step.run` / `agent`) — where a restart/resume would re-run them with a different
  value. It never blocks the command. Shared analysis via `@boardwalk-labs/workflow/lint`, so the
  CLI, the engines, and the hosted deploy flag the same thing.
- `dev`/`runs --logs` render the durable-suspension run events (`suspended` / `resumed` /
  `human_input_requested` / `human_input_resolved`).

### Changed

- Bumped to `@boardwalk-labs/workflow@^0.1.13` + `@boardwalk-labs/engine@^0.1.25` (so `boardwalk dev`
  picks up the budget parity fix: `max_duration_seconds` is active compute, suspended idle excluded).

## 0.1.20

### Added

- **`deploy` / `run` report the deployed slug.** Both now log the slug the server actually deployed
  to and warn when a linked directory points at a different-named workflow than the file's
  `meta.slug`, so a run is never silently attributed to the wrong name.
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

- **Stored session is fully validated on read.** The on-disk credentials file is now checked field
  by field, so a tampered/corrupt session is treated as logged-out rather than partially trusted.
  Internal: per-command logging, org resolution, and elevated-login hints were consolidated into
  shared helpers (no behavior change).
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
