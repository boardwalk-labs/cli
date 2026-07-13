// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  formatNotifications,
  runNotificationsList,
  runNotificationsUnread,
  runNotificationsRead,
} from "./notifications.js";
import type { NotificationItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const NOW = 1_700_000_000_000;
const NO_LINK = "/tmp/no-boardwalk-link";

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "01N",
    kind: "run_terminal",
    title: "nightly-report failed",
    body: "boom",
    link: "/acme/runs/01RUN",
    readAt: null,
    createdAt: NOW - 2 * 3600 * 1000,
    ...over,
  };
}

interface Call {
  url: string;
  method: string;
  body: string | null;
}

function routeFetch(routes: {
  notifications?: unknown[];
  nextCursor?: string | null;
  unread?: number;
  updated?: number;
}): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });
    if (url.endsWith("/notifications/unread-count")) {
      return Promise.resolve(new Response(JSON.stringify({ unread: routes.unread ?? 0 })));
    }
    if (/\/notifications\/read(-all)?$/.test(url)) {
      return Promise.resolve(new Response(JSON.stringify({ updated: routes.updated ?? 0 })));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          notifications: routes.notifications ?? [],
          nextCursor: routes.nextCursor ?? null,
        }),
      ),
    );
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatNotifications", () => {
  it("renders a header with the unread count and a dot on unread rows", () => {
    const out = formatNotifications("acme", [item(), item({ id: "02N", readAt: NOW })], NOW).join(
      "\n",
    );
    expect(out).toContain("Notifications · acme  (2, 1 unread)");
    expect(out).toMatch(/●\s+nightly-report failed/);
  });

  it("renders an empty state", () => {
    expect(formatNotifications("acme", [], NOW)[0]).toContain("No notifications in acme");
  });
});

describe("runNotificationsList", () => {
  it("GETs the org feed and honors --unread + --limit", async () => {
    const { fetchImpl, calls } = routeFetch({ notifications: [item()] });
    const lines: string[] = [];
    await runNotificationsList(
      { org: "acme", token: "t", unread: true, limit: "10" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW, cwd: NO_LINK },
    );
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/v1/orgs/acme/notifications?unread=true&limit=10");
    expect(lines.join("\n")).toContain("nightly-report failed");
  });

  it("--json prints the raw envelope", async () => {
    const { fetchImpl } = routeFetch({ notifications: [item()], nextCursor: "c1" });
    const lines: string[] = [];
    await runNotificationsList(
      { org: "acme", token: "t", json: true },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), now: NOW, cwd: NO_LINK },
    );
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ nextCursor: "c1" });
  });

  it("requires an org", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runNotificationsList({ token: "t" }, { config: CONFIG, fetchImpl, cwd: NO_LINK }),
    ).rejects.toThrow(/No org specified/);
  });
});

describe("runNotificationsUnread", () => {
  it("prints a bare count", async () => {
    const { fetchImpl, calls } = routeFetch({ unread: 4 });
    const lines: string[] = [];
    await runNotificationsUnread(
      { org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), cwd: NO_LINK },
    );
    expect(calls[0]?.url).toContain("/notifications/unread-count");
    expect(lines).toEqual(["4"]);
  });
});

describe("runNotificationsRead", () => {
  it("POSTs the ids to /read", async () => {
    const { fetchImpl, calls } = routeFetch({ updated: 2 });
    const lines: string[] = [];
    await runNotificationsRead(
      { ids: ["a", "b"], org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), cwd: NO_LINK },
    );
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toMatch(/\/notifications\/read$/);
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ ids: ["a", "b"] });
    expect(lines[0]).toContain("marked 2 read");
  });

  it("--all POSTs to /read-all", async () => {
    const { fetchImpl, calls } = routeFetch({ updated: 5 });
    const lines: string[] = [];
    await runNotificationsRead(
      { ids: [], all: true, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l), cwd: NO_LINK },
    );
    expect(calls[0]?.url).toMatch(/\/notifications\/read-all$/);
    expect(lines[0]).toContain("marked 5 read");
  });

  it("errors when neither ids nor --all is given", async () => {
    const { fetchImpl } = routeFetch({});
    await expect(
      runNotificationsRead(
        { ids: [], org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, cwd: NO_LINK },
      ),
    ).rejects.toThrow(/No notifications specified/);
  });
});
