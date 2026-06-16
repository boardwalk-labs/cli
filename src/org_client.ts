// SPDX-License-Identifier: MIT

// resolveOrgClient — the shared setup for org-scoped commands (`workflows`, `secrets`, `inference`):
// build the authenticated API client (token + base URL from the resolved login) and the effective
// org (--org, else the linked project's org). Auth + base precedence live in `resolveApiTarget`.

import type { CliConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { resolveApiTarget } from "./auth/resolve.js";
import { BoardwalkClient } from "./client.js";
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
): Promise<{ client: BoardwalkClient; org: string | undefined }> {
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
  return { client, org };
}
