// SPDX-License-Identifier: MIT

// `boardwalk notifications` — your in-app notifications for the org (the same feed the web shows):
//   • notifications list [--unread]   → watched-run outcomes, input requests, billing alerts
//   • notifications unread            → just the unread count (scriptable — prints a bare number)
//   • notifications read <ids...>     → mark specific notifications read
//   • notifications read --all        → mark every unread notification read
//
// The feed is always YOUR notifications in the active org (scoped to the caller server-side). Works
// under a `boardwalk login` session or a bwk_ API key with the `notification:read`/`:update` scopes.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { resolveOrgClient, requireOrg } from "../org_client.js";
import { resolveLog } from "../log.js";
import type { NotificationItem } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface NotificationsListOptions {
  org?: string | undefined;
  unread?: boolean | undefined;
  limit?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface NotificationsUnreadOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface NotificationsReadOptions {
  ids: string[];
  all?: boolean | undefined;
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface NotificationsDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
  now?: number;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`Invalid --limit "${value}".`, "Pass a positive integer.");
  }
  return n;
}

export async function runNotificationsList(
  opts: NotificationsListOptions,
  deps: NotificationsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const now = deps.now ?? Date.now();
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  const listOpts: { unread?: boolean; limit?: number } = {};
  if (opts.unread === true) listOpts.unread = true;
  const limit = parseLimit(opts.limit);
  if (limit !== undefined) listOpts.limit = limit;
  const result = await client.listNotifications(resolvedOrg, listOpts);
  if (opts.json === true) {
    log(JSON.stringify(result, null, 2));
    return;
  }
  for (const line of formatNotifications(resolvedOrg, result.notifications, now)) log(line);
}

export async function runNotificationsUnread(
  opts: NotificationsUnreadOptions,
  deps: NotificationsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const unread = await client.getUnreadNotificationCount(requireOrg(org));
  if (opts.json === true) {
    log(JSON.stringify({ unread }, null, 2));
    return;
  }
  log(String(unread));
}

export async function runNotificationsRead(
  opts: NotificationsReadOptions,
  deps: NotificationsDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const resolvedOrg = requireOrg(org);
  const ids = opts.ids.map((s) => s.trim()).filter((s) => s.length > 0);
  if (opts.all !== true && ids.length === 0) {
    throw new CliError(
      "No notifications specified.",
      "Pass ids (`notifications read <id>…`) or --all to clear everything.",
    );
  }
  const updated =
    opts.all === true
      ? await client.markAllNotificationsRead(resolvedOrg)
      : await client.markNotificationsRead(resolvedOrg, ids);
  if (opts.json === true) {
    log(JSON.stringify({ updated }, null, 2));
    return;
  }
  log(updated > 0 ? `✓ marked ${String(updated)} read.` : "Nothing to mark — already caught up.");
}

// ── formatter (pure — exported for tests) ───────────────────────────────────────────────────────

/** Render the feed as an aligned table; a leading dot marks unread rows. */
export function formatNotifications(org: string, items: NotificationItem[], now: number): string[] {
  if (items.length === 0) {
    return [`No notifications in ${org} yet.`];
  }
  const unread = items.filter((n) => n.readAt === null).length;
  const heading = `Notifications · ${org}  (${String(items.length)}${unread > 0 ? `, ${String(unread)} unread` : ""})`;
  const lines = [heading, "", `  ${col("", 2)}${col("TITLE", TITLE_W)}${col("KIND", KIND_W)}WHEN`];
  for (const n of items) {
    const dot = n.readAt === null ? "●" : " ";
    lines.push(
      `  ${col(dot, 2)}${col(n.title, TITLE_W)}${col(n.kind, KIND_W)}${age(n.createdAt, now)}`,
    );
  }
  return lines;
}

const TITLE_W = 42;
const KIND_W = 24;

function col(s: string, width: number): string {
  return (s.length > width - 1 ? `${s.slice(0, width - 2)}…` : s).padEnd(width);
}

function age(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.round(h / 24))}d ago`;
}
