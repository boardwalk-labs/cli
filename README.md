# @boardwalk/cli

The `boardwalk` command — author, validate, run locally, and deploy [Boardwalk](https://boardwalk.sh) workflows.

```
boardwalk init my-workflow                 # scaffold a project from a template
boardwalk dev ./index.ts                   # run it NOW, locally — no account needed
boardwalk check ./index.ts                 # validate locally (no auth/network)
boardwalk login                            # browser OAuth (PKCE) → stores a session
boardwalk deploy ./index.ts --org my-team  # ship it to Boardwalk Cloud
boardwalk run ./index.ts --org my-team --input '{"who":"world"}'   # deploy + trigger a real run
boardwalk cancel <runId>
boardwalk logout / whoami
```

## The author loop

- **`init [dir]`** — scaffold a workflow project: program file, `package.json`, `.env.example`,
  `.gitignore`. The default template runs green under `dev` immediately.
- **`dev <file|dir>`** — run the workflow right here, right now. Derives + validates the manifest
  (precise errors before anything runs), bundles the program, executes it in-process, and streams
  the run-event log. Secrets resolve from `.env` (or `--env-file`); values never print.
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
> The embedded local engine (`@boardwalk/engine`) makes them work in `dev` — it's next on the
> [roadmap](./SPEC.md).

## Deploying

- **`deploy <file|dir> --org <slug>`** — create/update the workflow (idempotent by `meta.name`).
  `--dry-run` prints the plan only.
- **`run <file|dir> --org <slug>`** — deploy the current source, trigger a **real run on the
  platform**, and wait for it to finish. `--no-wait` triggers and exits.

`deploy` builds the program into a content-addressed artifact: esbuild bundles your entry (deps
pinned at deploy, `@boardwalk/workflow` stays external), package assets (markdown skills, prompt
templates) ride along at their relative paths, and the lot is packed into a deterministic tarball,
uploaded via a presigned URL, and verified server-side. The server re-derives the manifest from
your `meta` — the CLI never sends a hand-built manifest.

### Project link (`.boardwalk/project.json`)

The first `deploy`/`run` in a directory writes `.boardwalk/project.json` (gitignored, Vercel-style)
with `{ orgSlug, workflowId }`. After that the workflow is identified by that stored **id**, so
`--org` is optional and renaming `meta.name` or the entry file updates the same workflow instead of
forking a new one. On a fresh clone, pass `--org` once to re-link (it adopts an existing same-name
workflow if present, else creates one).

## Authentication

Resolved in this precedence:

1. `--token <bearer>` flag (one-off / scripting)
2. `BOARDWALK_API_KEY` env (CI / headless — a `bwk_…` API key)
3. the stored session from `boardwalk login` — either a browser **OAuth/PKCE** session
   (auto-refreshed when expired) **or** an API key persisted via `boardwalk login --token <key>`

`boardwalk login` speaks standard OAuth 2.0 Authorization-Code + PKCE against the deployment's own
issuer: it fetches `/.well-known/oauth-authorization-server` to discover the endpoints, starts a
localhost callback server, opens your browser, exchanges the code, and stores the session in
`<config>/credentials.json` (mode 0600). The CLI session is **scoped, least-privilege** — it can
deploy and trigger/read runs, but cannot mint API keys, manage billing/members, or read secrets.

`init`, `dev`, and `check` need no account at all.

## Configuration (env)

Point the CLI at any deployment — Boardwalk Cloud (default), or a **self-hosted** install on your
own domain — without rebuilding:

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

## License

MIT
