// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatInfo, formatRotated, runWebhook } from "./webhook.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

// A ULID ref passes straight through resolveWorkflowId (no list fetch), so the only calls are the
// webhook endpoints — keeps each test's `calls` assertion exact.
const WF_ID = "01KV0000000000000000000007";
const NO_LINK = "/tmp/boardwalk-no-link-xyz";

interface Call {
  url: string;
  method: string;
}

/** Route GET .../webhook and POST .../webhook/rotate. `rotateStatus` forces an error on the POST. */
function routeFetch(routes: { webhook?: unknown; rotated?: unknown; rotateStatus?: number }): {
  fetchImpl: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/webhook/rotate")) {
      const status = routes.rotateStatus ?? 200;
      if (status >= 400) {
        return Promise.resolve(new Response(JSON.stringify({ error: "forbidden" }), { status }));
      }
      return Promise.resolve(new Response(JSON.stringify(routes.rotated ?? {})));
    }
    return Promise.resolve(new Response(JSON.stringify(routes.webhook ?? {})));
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("formatInfo", () => {
  it("token mode shows the endpoint + how to reveal the full URL", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "token",
    }).join("\n");
    expect(out).toContain("Webhook · nightly");
    expect(out).toContain("https://wh.x/v1/workflows/abc/<token>");
    expect(out).toMatch(/Auth\s+token/);
    expect(out).toContain("boardwalk webhook nightly --rotate");
  });

  it("signature mode shows the URL + the HMAC header", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "signature",
    }).join("\n");
    expect(out).toMatch(/URL\s+https:\/\/wh\.x\/v1\/workflows\/abc/);
    expect(out).toContain("X-Boardwalk-Signature");
  });
});

describe("formatRotated", () => {
  it("token mode reveals the full URL with show-once + paste guidance", () => {
    const out = formatRotated("nightly", {
      url: "https://wh.x/v1/workflows/abc/whk_xyz",
      auth: "token",
      secret: "whk_xyz",
    }).join("\n");
    expect(out).toContain("✓ Generated the webhook URL for nightly.");
    expect(out).toContain("https://wh.x/v1/workflows/abc/whk_xyz");
    expect(out).toContain("shown only once");
  });

  it("signature mode reveals the secret as the HMAC key", () => {
    const out = formatRotated("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "signature",
      secret: "whk_xyz",
    }).join("\n");
    expect(out).toContain("✓ Rotated the signing secret for nightly.");
    expect(out).toMatch(/Secret\s+whk_xyz/);
  });
});

describe("runWebhook", () => {
  it("GETs the webhook info and renders it (token mode)", async () => {
    const { fetchImpl, calls } = routeFetch({
      webhook: { webhook: { url: "https://wh.x/v1/workflows/abc", auth: "token" } },
    });
    const lines: string[] = [];
    await runWebhook(
      { ref: WF_ID, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toEqual([
      { url: `https://api.x/v1/orgs/acme/workflows/${WF_ID}/webhook`, method: "GET" },
    ]);
    expect(lines.join("\n")).toContain("/v1/workflows/abc/<token>");
  });

  it("--rotate POSTs to /rotate and reveals the full URL once", async () => {
    const { fetchImpl, calls } = routeFetch({
      rotated: {
        webhook: { url: "https://wh.x/v1/workflows/abc/whk_xyz", auth: "token", secret: "whk_xyz" },
      },
    });
    const lines: string[] = [];
    await runWebhook(
      { ref: WF_ID, org: "acme", rotate: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toEqual([
      { url: `https://api.x/v1/orgs/acme/workflows/${WF_ID}/webhook/rotate`, method: "POST" },
    ]);
    expect(lines.join("\n")).toContain("https://wh.x/v1/workflows/abc/whk_xyz");
  });

  it("emits raw JSON with --json", async () => {
    const { fetchImpl } = routeFetch({
      webhook: { webhook: { url: "https://wh.x/v1/workflows/abc", auth: "token" } },
    });
    const lines: string[] = [];
    await runWebhook(
      { ref: WF_ID, org: "acme", json: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(JSON.parse(lines.join("\n"))).toEqual({
      webhook: { url: "https://wh.x/v1/workflows/abc", auth: "token" },
    });
  });

  it("errors actionably when the workflow has no webhook trigger", async () => {
    const { fetchImpl } = routeFetch({ webhook: { webhook: null } });
    await expect(
      runWebhook(
        { ref: WF_ID, org: "acme", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/no webhook trigger/);
  });

  it("requires an org", async () => {
    const { fetchImpl } = routeFetch({ webhook: { webhook: null } });
    await expect(
      runWebhook(
        { ref: WF_ID, token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, cwd: NO_LINK },
      ),
    ).rejects.toThrow(/No org specified/);
  });

  it("--rotate maps a 403 to an elevation hint", async () => {
    const { fetchImpl } = routeFetch({ rotateStatus: 403 });
    await expect(
      runWebhook(
        { ref: WF_ID, org: "acme", rotate: true, token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/elevated session/);
  });
});
