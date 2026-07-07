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
  it("token preset shows the BARE endpoint (never a token path segment) + the header to use", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "token",
      preset: "token",
      header: null,
    }).join("\n");
    expect(out).toContain("Webhook · nightly");
    expect(out).toMatch(/Endpoint\s+https:\/\/wh\.x\/v1\/workflows\/abc$/m);
    expect(out).not.toContain("<token>");
    expect(out).toContain("X-Boardwalk-Token");
    expect(out).toContain("never in the URL");
    expect(out).toContain("boardwalk webhook nightly --rotate");
  });

  it("falls back on the auth family when the server sends no preset (older server)", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "token",
      preset: null,
      header: null,
    }).join("\n");
    expect(out).toContain("X-Boardwalk-Token");
    expect(out).not.toContain("<token>");
  });

  it("custom_header preset names the configured header", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "token",
      preset: "custom_header",
      header: "x-my-token",
    }).join("\n");
    expect(out).toContain("x-my-token");
  });

  it("signature preset shows the URL + the HMAC header", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "signature",
      preset: "signature",
      header: null,
    }).join("\n");
    expect(out).toMatch(/Endpoint\s+https:\/\/wh\.x\/v1\/workflows\/abc/);
    expect(out).toContain("X-Boardwalk-Signature");
  });

  it("provider presets name the provider's scheme", () => {
    const out = formatInfo("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "signature",
      preset: "github",
      header: null,
    }).join("\n");
    expect(out).toContain("X-Hub-Signature-256");
  });
});

describe("formatRotated", () => {
  it("token preset reveals the SECRET (not a token-bearing URL) with show-once guidance", () => {
    const out = formatRotated("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "token",
      preset: "token",
      header: null,
      secret: "whk_xyz",
    }).join("\n");
    expect(out).toContain("✓ Rotated the webhook secret for nightly.");
    expect(out).toMatch(/Endpoint\s+https:\/\/wh\.x\/v1\/workflows\/abc$/m);
    expect(out).toMatch(/Secret\s+whk_xyz/);
    expect(out).toContain("shown only once");
    expect(out).toContain("X-Boardwalk-Token");
  });

  it("signature preset reveals the secret as the HMAC key", () => {
    const out = formatRotated("nightly", {
      url: "https://wh.x/v1/workflows/abc",
      auth: "signature",
      preset: "signature",
      header: null,
      secret: "whk_xyz",
    }).join("\n");
    expect(out).toContain("✓ Rotated the webhook secret for nightly.");
    expect(out).toMatch(/Secret\s+whk_xyz/);
    expect(out).toContain("X-Boardwalk-Signature");
  });
});

describe("runWebhook", () => {
  it("GETs the webhook info and renders it (token preset)", async () => {
    const { fetchImpl, calls } = routeFetch({
      webhook: {
        webhook: { url: "https://wh.x/v1/workflows/abc", auth: "token", preset: "token" },
      },
    });
    const lines: string[] = [];
    await runWebhook(
      { ref: WF_ID, org: "acme", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(calls).toEqual([
      { url: `https://api.x/v1/orgs/acme/workflows/${WF_ID}/webhook`, method: "GET" },
    ]);
    const out = lines.join("\n");
    expect(out).toContain("https://wh.x/v1/workflows/abc");
    expect(out).toContain("X-Boardwalk-Token");
    expect(out).not.toContain("<token>");
  });

  it("--rotate POSTs to /rotate and reveals the secret once", async () => {
    const { fetchImpl, calls } = routeFetch({
      rotated: {
        webhook: {
          url: "https://wh.x/v1/workflows/abc",
          auth: "token",
          preset: "token",
          secret: "whk_xyz",
        },
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
    const out = lines.join("\n");
    expect(out).toMatch(/Secret\s+whk_xyz/);
    expect(out).toMatch(/Endpoint\s+https:\/\/wh\.x\/v1\/workflows\/abc$/m);
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
      webhook: { url: "https://wh.x/v1/workflows/abc", auth: "token", preset: null, header: null },
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
