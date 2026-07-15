# @boardwalk-labs/cli

The `boardwalk` command — author, validate, run locally, and deploy [Boardwalk](https://boardwalk.sh) workflows.

```
boardwalk init my-workflow                 # scaffold a project from a template
boardwalk dev ./index.ts                   # run it locally — no account needed
boardwalk check ./index.ts                 # validate locally (no auth/network)
boardwalk login                            # browser OAuth (PKCE) → stores a session
boardwalk deploy ./index.ts --org my-team  # ship it to the Boardwalk platform
boardwalk run ./index.ts --org my-team --input '{"who":"world"}'   # deploy + trigger a real run
boardwalk runs                             # recent runs (or --workflow <id|slug> to scope)
boardwalk runs <runId> --logs              # what a run did; --follow to live-tail
boardwalk workflows                        # the org's workflows (show <id|slug>, delete <id|slug>)
boardwalk cancel <runId>
boardwalk logout / whoami
boardwalk status                           # host + login (live-verified) + project link
```

## The author loop

- **`init [dir]`** — scaffold a workflow project: program file, `package.json`, `.env.example`,
  `.gitignore`. The default template runs green under `dev` immediately. Also drops the
  Boardwalk agent skills into `.claude/skills/` so a coding agent in the project can drive the
  CLI with local context (best-effort: skipped offline; `BOARDWALK_SKILLS_URL` overrides the
  source).
- **`dev <file|dir>`** — run the workflow locally. Derives and validates the manifest
  (precise errors before anything runs), bundles the program, executes it in-process, and streams
  the run-event log. Secrets resolve from `.env` (or `--env <path>`); values never print.
  Exit code is the run's verdict: `0` completed, `1` failed, `130` cancelled (Ctrl-C).
- **`check <file|dir>`** — everything `dev` validates, without running: full manifest-schema
  validation (the same schema every engine enforces) + an esbuild compile proving every import
  resolves.

### Choosing what to watch

Every engine emits the same typed event stream, and every event belongs to one channel:
`lifecycle`, `phase`, `output`, `log`, `agent`. The flags mean the same thing everywhere:

```
boardwalk dev ./index.ts                    # default: lifecycle + phase + output (quiet, readable)
boardwalk dev ./index.ts --verbose          # everything: agent turns, tool calls, captured logs
boardwalk dev ./index.ts --stream output | jq   # just the result — pipe-friendly
boardwalk dev ./index.ts --stream phase,log
```

> `dev` today executes the program primitives (secrets, sleeps, phases, output, artifacts)
> in-process; `agent()` and `workflows.call()` need an engine and fail with a clear pointer.
> The embedded local engine (`@boardwalk-labs/engine`) makes them work in `dev` — it's next on the
> [roadmap](./SPEC.md).

## Deploying

- **`deploy <file|dir> --org <slug>`** — create/update the workflow (idempotent by `meta.slug`).
  `--dry-run` prints the plan only.
- **`run <file|dir> --org <slug>`** — deploy the current source, trigger a **real run on the
  platform**, and wait for it to finish. `--no-wait` triggers and exits.

`deploy` builds the program into a content-addressed artifact: esbuild bundles your entry (deps
pinned at deploy, `@boardwalk-labs/workflow` stays external), package assets (markdown skills, prompt
templates) ride along at their relative paths, and the lot is packed into a deterministic tarball,
uploaded via a presigned URL, and verified server-side. The server re-derives the manifest from
your `meta` — the CLI never sends a hand-built manifest.

### Project link (`.boardwalk/project.json`)

The first `deploy`/`run` in a directory writes a gitignored `.boardwalk/project.json`
with `{ orgSlug, workflowId }`. After that the workflow is identified by that stored **id**, so
`--org` is optional and renaming `meta.slug` or the entry file updates the same workflow instead of
forking a new one. On a fresh clone, pass `--org` once to re-link (it adopts an existing same-name
workflow if present, else creates one).

## Observing runs + workflows

```
boardwalk runs                              # recent runs, newest first (--status / --limit)
boardwalk runs --workflow merge-bot         # scope the list to one workflow (id or slug)
boardwalk runs <runId>                      # one run's summary (status, duration, tokens, error)
boardwalk runs <runId> --logs               # its event log — same channels as `dev`
boardwalk runs <runId> --logs --verbose     # + agent turns + every tool call
boardwalk runs <runId> --follow             # live-tail over SSE until it finishes (Ctrl-C aborts)

boardwalk workflows                         # the org's workflows (slug, title, triggers, last run)
boardwalk workflows show <id|slug>          # manifest projection + version history
boardwalk workflows delete <id|slug> --yes  # delete (irreversible; --yes required)
```

`--logs`/`--follow` render the same typed event stream as `dev`, so `--stream <channels>` /
`--verbose` mean the same thing. A run id needs no `--org` (the run resolves its own org); a
workflow **slug** is resolved against the org (`--org` or the project link), while a workflow **id**
(a ULID, as in a dashboard URL) is used directly.

## Managing secrets + inference providers

```
boardwalk secrets                           # the org's secrets (names/scope/kind — never values)
echo "$TOKEN" | boardwalk secrets set GITHUB_TOKEN   # stage a value (piped → out of shell history)
boardwalk secrets set DEPLOY_KEY --from-file ./key   # …or from a file; --value is also accepted
boardwalk secrets delete GITHUB_TOKEN --yes

boardwalk inference                         # BYO inference providers (endpoints only — never keys)
echo "$KEY" | boardwalk inference add my-openai --source openai
boardwalk inference add vllm --source openai_compatible --base-url https://vllm.internal --api-key …
boardwalk inference delete my-openai --yes
```

## Environments + variables

An **environment** is a named set of config (secrets + non-secret variables) a run targets by name;
the org base always applies underneath. A **variable** is non-secret config injected into the run as
a `process.env` value (read it with `process.env.NAME`). The environment is chosen per run, not in the
manifest — pass `--environment` to `run`:

```
boardwalk environments                       # named environments (org base always applies underneath)
boardwalk environments create Production
boardwalk environments delete Production --yes

boardwalk variables                          # non-secret variables (VALUES are shown — they're not secret)
boardwalk variables set POSTHOG_PROJECT_ID 394895 --environment Production
boardwalk variables list --environment Production
boardwalk variables delete REGION --yes

boardwalk run ./index.ts --org my-team --environment Production   # run against an environment
```

Use **secrets** (above) for credentials — never store a secret as a variable.

Secret VALUES are never displayed by any surface — `list` shows a name + a last-4 hint. Provider API
keys are staged into Secrets Manager server-side and never returned. **Writes (`set`/`delete`,
`add`, and `workflows delete`) need an ELEVATED login** — see below; the default login is read-only
for these.

## Authentication

Resolved in this precedence:

1. `--token <bearer>` flag (one-off / scripting)
2. `BOARDWALK_API_KEY` env (CI / headless — a `bwk_…` API key)
3. the stored session from `boardwalk login` — either a browser **OAuth/PKCE** session
   (auto-refreshed when expired) **or** an API key persisted via `boardwalk login --token <key>`

`boardwalk login` speaks standard OAuth 2.0 Authorization-Code + PKCE against the deployment's own
issuer: it fetches `/.well-known/oauth-authorization-server` to discover the endpoints, starts a
localhost callback server, opens your browser, exchanges the code, and stores the session in
`<config>/credentials.json` (mode 0600). The default CLI session is **scoped, least-privilege** — it
can deploy, trigger/read runs, and LIST secrets + providers (names/endpoints only, never values), but
cannot write secrets, wire providers, delete workflows, mint API keys, or manage billing/members.

**Elevated login (`boardwalk login --scopes admin`)** opts into the org-admin write scopes — managing
secrets, wiring inference providers, and deleting workflows — for that session. You must be an org
admin for it to take effect. It is deliberately bounded: even elevated, a CLI token can never mint a
full-power API key or invite members (those stay web-session-only), so a leaked token's blast radius
is contained. Use the default login for everyday deploy/run; reach for `--scopes admin` only when you
need to manage the org's credentials from the terminal.

`init`, `dev`, and `check` need no account at all.

## Configuration (env)

Point the CLI at any deployment — the Boardwalk platform (default), or a **self-hosted** install on your
own domain — without rebuilding. **Host precedence:** an explicit `BOARDWALK_API_URL` /
`BOARDWALK_API_DOMAIN` wins; otherwise, when you're using a stored `login` session, its own API
origin is used (so logging into a dev / self-host stack just works — no per-call env needed); else
the prod default. `boardwalk status` shows the resolved host and how it was chosen.

| Variable                    | Default                    | Purpose                                        |
| --------------------------- | -------------------------- | ---------------------------------------------- |
| `BOARDWALK_API_DOMAIN`      | `api.boardwalk.sh`         | API host → `https://<domain>` (self-host knob) |
| `BOARDWALK_API_URL`         | —                          | Full API URL override (local http / ports)     |
| `BOARDWALK_ISSUER_URL`      | `https://api.boardwalk.sh` | OAuth issuer origin for `login` (discovery)    |
| `BOARDWALK_OAUTH_CLIENT_ID` | `boardwalk-cli`            | OAuth client id (built-in default)             |
| `BOARDWALK_OAUTH_PORT`      | `53682`                    | Loopback redirect port                         |
| `BOARDWALK_API_KEY`         | —                          | API key for non-interactive auth               |
| `BOARDWALK_CONFIG_DIR`      | XDG config dir             | Where credentials are stored                   |

## Develop

```
pnpm install
pnpm test
pnpm lint
pnpm build      # → dist/, run via ./bin/boardwalk.js
pnpm boardwalk -- dev ./index.ts   # run from source via tsx
```

## The Boardwalk repos

- [`boardwalk`](https://github.com/boardwalk-labs/boardwalk) — the open-source single-node engine: cron scheduling, webhooks, durable runs, run history
- [`sdk`](https://github.com/boardwalk-labs/sdk) — `@boardwalk-labs/workflow`, the TypeScript API a workflow program imports
- [`examples`](https://github.com/boardwalk-labs/examples) — copyable workflow templates (`boardwalk init --template`)
- [`plugins`](https://github.com/boardwalk-labs/plugins) — skills + MCP server for Claude Code, Codex, Cursor, OpenClaw, OpenCode
- [`runner`](https://github.com/boardwalk-labs/runner) — self-hosted runner: your machines execute hosted-scheduled runs

Hosted platform and docs: [boardwalk.sh](https://boardwalk.sh).

## License

MIT
