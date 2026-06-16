// SPDX-License-Identifier: MIT

// `boardwalk status` — a one-stop diagnostic: which host am I pointed at, am I logged in (and does
// my token actually work), and what's this directory linked to.
//
// `whoami` is the quick LOCAL check (a stored session exists). `status` is the richer, network-aware
// one: it adds the resolved API host (the dev/prod/self-host the same binary silently targets), a
// live `GET /v1/me` that PROVES the credential is valid + names the account, and the project link
// for the cwd. It degrades gracefully — host + local auth still print when offline or logged out.
//
// Auth precedence matches the other commands: --token > BOARDWALK_API_KEY env > stored login. Exit
// is non-zero when there's no usable credential (or the server rejected it), so it's scriptable.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveToken } from "../auth/resolve.js";
import { BoardwalkClient } from "../client.js";
import { readLink, projectDirFor, type ProjectLink } from "../project.js";
import type { FetchLike } from "../auth/pkce.js";

export interface StatusOptions {
  token?: string | undefined;
}

export interface StatusDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Epoch ms, for humanizing token expiry (injectable for tests). */
  now?: number;
  /** CLI version for the header (passed from the entrypoint; omitted from the header when absent). */
  version?: string;
  /** Set the process exit code (default mutates `process.exitCode`; injectable for tests). */
  setExitCode?: (code: number) => void;
}

/** How the API host was chosen — surfaced so "am I on dev or prod?" always has an answer. */
type HostSource = "BOARDWALK_API_URL" | "BOARDWALK_API_DOMAIN" | "default";

/** The local credential in effect, by precedence — drives the "Auth" line. */
type AuthDescriptor =
  | { kind: "flag" }
  | { kind: "env" }
  | { kind: "oauth"; scope: string | null; expiresAt: number | null }
  | { kind: "apiKey" }
  | { kind: "none" };

/** The outcome of the live `GET /v1/me` probe (or why it was skipped) — drives the "Account" line. */
type AccountProbe =
  | {
      kind: "ok";
      email: string;
      name: string | null;
      orgs: { slug: string | null; role: string }[];
    }
  | { kind: "rejected" } // 401/403 — token present but the server refused it
  | { kind: "unreachable" } // network error / non-auth failure — creds may be fine, couldn't verify
  | { kind: "expired" } // stored session expired and can't be refreshed
  | { kind: "none" }; // no credential at all

export interface StatusReport {
  version: string | undefined;
  host: { url: string; source: HostSource };
  auth: AuthDescriptor;
  account: AccountProbe;
  project: ProjectLink | null;
}

export async function runStatus(opts: StatusOptions, deps: StatusDeps): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const setExitCode =
    deps.setExitCode ??
    ((code: number): void => {
      process.exitCode = code;
    });

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { auth, account } = await resolveAuthAndProbe(opts, deps, store, env, now);

  const report: StatusReport = {
    version: deps.version,
    host: { url: deps.config.apiBaseUrl, source: hostSource(env) },
    auth,
    account,
    project: readLink(projectDirFor(deps.cwd ?? process.cwd())),
  };

  for (const line of formatStatus(report, now)) log(line);

  // Non-zero only when there's nothing usable, or the server actively refused the credential — an
  // unreachable host (offline) leaves a valid local credential intact, so that stays exit 0.
  if (account.kind === "none" || account.kind === "rejected" || account.kind === "expired") {
    setExitCode(1);
  }
}

/** Resolve the local credential (for the Auth line) and, when one exists, run the live `/v1/me`
 *  probe (for the Account line). Never throws — every failure becomes a reportable state. */
async function resolveAuthAndProbe(
  opts: StatusOptions,
  deps: StatusDeps,
  store: CredentialStore,
  env: NodeJS.ProcessEnv,
  now: number,
): Promise<{ auth: AuthDescriptor; account: AccountProbe }> {
  // Follow the same precedence as resolveToken, but report each rung instead of collapsing to a token.
  const flag = opts.token?.trim();
  if (flag !== undefined && flag.length > 0) {
    return { auth: { kind: "flag" }, account: await probe(deps, flag) };
  }
  const envKey = env.BOARDWALK_API_KEY?.trim();
  if (envKey !== undefined && envKey.length > 0) {
    return { auth: { kind: "env" }, account: await probe(deps, envKey) };
  }
  if (store.getSession() === null) {
    return { auth: { kind: "none" }, account: { kind: "none" } };
  }

  // A stored login exists. resolveToken refreshes an expired OAuth session in place, so probe with
  // its result, then re-read the session for an accurate (post-refresh) Auth descriptor.
  let token: string;
  try {
    token = await resolveToken({
      config: deps.config,
      store,
      env,
      now,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
    });
  } catch {
    // Expired and unrefreshable (no/dead refresh token) — describe the stored session, flag expired.
    return { auth: describeStoredSession(store), account: { kind: "expired" } };
  }
  return { auth: describeStoredSession(store), account: await probe(deps, token) };
}

/** Build the Auth descriptor from the stored session: an API key (no token endpoint) vs an OAuth
 *  session (carries scope + expiry). Falls back to `none` if the session vanished mid-resolve. */
function describeStoredSession(store: CredentialStore): AuthDescriptor {
  const session = store.getSession();
  if (session === null) return { kind: "none" };
  if (session.tokenEndpoint === null) return { kind: "apiKey" };
  return { kind: "oauth", scope: session.scope, expiresAt: session.expiresAt };
}

/** Hit `GET /v1/me` with the resolved token; classify the outcome. 401/403 ⇒ rejected; any other
 *  failure (network, 5xx) ⇒ unreachable, since the credential itself may be fine. */
async function probe(deps: StatusDeps, token: string): Promise<AccountProbe> {
  const client = new BoardwalkClient({
    baseUrl: deps.config.apiBaseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  try {
    const me = await client.getMe();
    return {
      kind: "ok",
      email: me.user.email,
      name: me.user.name,
      orgs: me.memberships.map((m) => ({ slug: m.slug, role: m.role })),
    };
  } catch (err) {
    if (err instanceof CliError && (err.status === 401 || err.status === 403)) {
      return { kind: "rejected" };
    }
    return { kind: "unreachable" };
  }
}

/** Mirror resolveApiBaseUrl's precedence to label HOW the host was chosen. */
function hostSource(env: NodeJS.ProcessEnv): HostSource {
  if (nonEmpty(env.BOARDWALK_API_URL)) return "BOARDWALK_API_URL";
  if (nonEmpty(env.BOARDWALK_API_DOMAIN)) return "BOARDWALK_API_DOMAIN";
  return "default";
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/** Render the status report as aligned plain-text lines (pure — exported for tests). */
export function formatStatus(report: StatusReport, now: number): string[] {
  const lines: string[] = [
    report.version !== undefined ? `Boardwalk CLI ${report.version}` : "Boardwalk CLI",
    "",
    row("Host", `${report.host.url}  (${report.host.source})`),
    row("Account", accountLine(report.account)),
  ];

  const authLine = authDescriptorLine(report.auth, now);
  if (authLine !== null) lines.push(row("Auth", authLine));

  if (report.account.kind === "ok" && report.account.orgs.length > 0) {
    const orgs = report.account.orgs.map((o) => `${o.slug ?? "(unknown)"} (${o.role})`).join(" · ");
    lines.push(row("Orgs", orgs));
  }

  lines.push(
    row(
      "Project",
      report.project === null
        ? "not linked — run `boardwalk deploy`"
        : `${report.project.orgSlug} / ${report.project.workflowId}`,
    ),
  );
  return lines;
}

function accountLine(account: AccountProbe): string {
  switch (account.kind) {
    case "ok":
      return account.name !== null && account.name.length > 0
        ? `✓ ${account.email} (${account.name})`
        : `✓ ${account.email}`;
    case "rejected":
      return "✗ token rejected — run `boardwalk login`";
    case "expired":
      return "✗ session expired — run `boardwalk login`";
    case "unreachable":
      return "? could not verify (host unreachable)";
    case "none":
      return "✗ not logged in — run `boardwalk login`";
  }
}

/** The "Auth" line for the local credential, or null to omit it (when there is none — the Account
 *  line already says so). */
function authDescriptorLine(auth: AuthDescriptor, now: number): string | null {
  switch (auth.kind) {
    case "flag":
      return "--token (one-off)";
    case "env":
      return "BOARDWALK_API_KEY (env)";
    case "apiKey":
      return "API key (stored)";
    case "oauth":
      return `OAuth session · scope=${auth.scope ?? "—"} · ${humanizeExpiry(auth.expiresAt, now)}`;
    case "none":
      return null;
  }
}

/** "expires in 13h" / "expired" / "never expires" — a compact, human relative expiry. */
function humanizeExpiry(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return "never expires";
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  return `expires in ${humanizeDuration(ms)}`;
}

function humanizeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.round(hours / 24))}d`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(9)} ${value}`;
}
