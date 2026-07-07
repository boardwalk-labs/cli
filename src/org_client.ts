// SPDX-License-Identifier: MIT

// resolveOrgClient — the shared setup for org-scoped commands (`workflows`, `secrets`, `inference`):
// build the authenticated API client (token + base URL from the resolved login) and the effective
// org (--org, else the linked project's org). Auth + base precedence live in `resolveApiTarget`.

import type { CliConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { resolveApiTarget } from "./auth/resolve.js";
import { BoardwalkClient } from "./client.js";
import { CliError } from "./errors.js";
import { readLink } from "./project.js";
import type { FetchLike } from "./auth/pkce.js";

export interface OrgClientDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
}

export async function resolveOrgClient(
  deps: OrgClientDeps,
  opts: { org?: string | undefined; token?: string | undefined },
): Promise<{ client: BoardwalkClient; org: string | undefined; baseUrl: string }> {
  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { token, baseUrl } = await resolveApiTarget({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const org = (opts.org ?? "").trim() || readLink(deps.cwd ?? process.cwd())?.orgSlug;
  return { client, org, baseUrl };
}

/** Require an org slug (from `--org` or the linked project). Throws a `CliError` when absent. */
export function requireOrg(org: string | undefined): string {
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  return org;
}

/**
 * Map a 403 from an admin-gated write to the elevated-login hint (the common cause: a default CLI
 * session). `action` names what was attempted (e.g. "Rotating a webhook secret"); other errors pass
 * through unchanged.
 */
export function elevationHint(err: unknown, action = "This action"): unknown {
  if (err instanceof CliError && err.status === 403) {
    return new CliError(
      `${action} needs an elevated session.`,
      "Run `boardwalk login --scopes admin` (you must be an org admin), then retry.",
    );
  }
  return err;
}
