// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { formatAllowances, formatUsage, runUsage } from "./usage.js";
import type { UsageSummary } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

function sample(over: Partial<UsageSummary> = {}): UsageSummary {
  return {
    rangeDays: 30,
    totals: { runs: 1204, tokensIn: 12_100_000, tokensOut: 6_300_000, runtimeSeconds: 50_520 },
    creditCents: 12_400,
    autonomy: { humanRuns: 72, automatedRuns: 1132 },
    cache: { hitRate: 0.42, cachedReadTokens: 5_000_000 },
    byModel: [
      { label: "anthropic/claude-sonnet-4.5", tokens: 14_200_000 },
      { label: "anthropic/claude-opus-4.8", tokens: 3_100_000 },
    ],
    byWorkflow: [{ label: "nightly-summary", tokens: 8_100_000 }],
    ...over,
  };
}

/** A fetch that answers the usage GET with `body` (a `{ usage }` envelope), the best-effort
 *  allowances GET with `allowances` (404 when omitted — the older-backend case), and records the
 *  URLs. */
function usageFetch(body: unknown, allowances?: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("/billing/allowances")) {
      return Promise.resolve(
        allowances === undefined
          ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
          : new Response(JSON.stringify(allowances), { status: 200 }),
      );
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as FetchLike;
  return { fetchImpl, urls };
}

/** A representative allowances payload (a Solo org mid-cycle). */
function sampleAllowances(): unknown {
  return {
    plan: "solo",
    periodStart: 1_720_000_000_000,
    periodEnd: 1_722_678_400_000, // 2024-08-03 UTC
    cancelAtPeriodEnd: false,
    gauges: {
      agentHours: { included: 25, used: 14.2 },
      tokenPool: { includedCents: 1000, usedCents: 610 },
      searches: { included: 500, used: 312 },
    },
    spendCap: { capCents: 5000, setAt: 1_720_000_000_000, usedCents: 1234 },
  };
}

describe("formatUsage", () => {
  it("renders the headline rows + top breakdowns", () => {
    const out = formatUsage("acme-corp", sample()).join("\n");
    expect(out).toContain("Usage · acme-corp · last 30 days");
    expect(out).toMatch(/Runs\s+1,204/);
    expect(out).toMatch(/Compute\s+842 min/); // 50520s / 60 ≈ 842
    expect(out).toMatch(/Tokens\s+18\.4M\s+\(12\.1M in · 6\.3M out\)/);
    expect(out).toMatch(/Credit\s+\$124\.00/);
    expect(out).toMatch(/Autonomy\s+94% automated/); // 1132 / 1204 ≈ 94%
    expect(out).toMatch(/Cache hit\s+42%/);
    expect(out).toContain("Top models");
    expect(out).toMatch(/anthropic\/claude-sonnet-4\.5\s+14\.2M/);
    expect(out).toContain("Top workflows (by tokens)");
    expect(out).toMatch(/nightly-summary\s+8\.1M/);
  });

  it("shows — for an unavailable credit balance and 0% autonomy when there are no runs", () => {
    const out = formatUsage(
      "acme-corp",
      sample({ creditCents: null, autonomy: { humanRuns: 0, automatedRuns: 0 } }),
    ).join("\n");
    expect(out).toMatch(/Credit\s+—/);
    expect(out).toMatch(/Autonomy\s+0% automated/);
  });

  it("omits a breakdown section entirely when it has no token volume", () => {
    const out = formatUsage("acme-corp", sample({ byModel: [], byWorkflow: [] })).join("\n");
    expect(out).not.toContain("Top models");
    expect(out).not.toContain("Top workflows");
  });
});

describe("runUsage", () => {
  it("fetches the org's usage and logs the formatted summary", async () => {
    const { fetchImpl, urls } = usageFetch({ usage: sample() });
    const lines: string[] = [];
    await runUsage(
      { org: "acme-corp", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(urls).toEqual([
      "https://api.x/v1/orgs/acme-corp/usage",
      "https://api.x/v1/orgs/acme-corp/billing/allowances",
    ]);
    expect(lines.join("\n")).toContain("Usage · acme-corp · last 30 days");
  });

  it("passes --days through as a query param", async () => {
    const { fetchImpl, urls } = usageFetch({ usage: sample() });
    await runUsage(
      { org: "acme-corp", days: "7", token: "t" },
      { config: CONFIG, fetchImpl, log: () => undefined },
    );
    expect(urls).toEqual([
      "https://api.x/v1/orgs/acme-corp/usage?days=7",
      "https://api.x/v1/orgs/acme-corp/billing/allowances",
    ]);
  });

  it("prints raw JSON with --json", async () => {
    const { fetchImpl } = usageFetch({ usage: sample() });
    const lines: string[] = [];
    await runUsage(
      { org: "acme-corp", json: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const parsed = JSON.parse(lines.join("\n")) as UsageSummary;
    expect(parsed.totals.runs).toBe(1204);
    expect(lines.join("\n")).not.toContain("Usage ·"); // no formatted output
  });

  it("maps a 404 to a friendly 'org not found' error, not the raw GET path", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "Org ghost not found" } }), {
          status: 404,
        }),
      )) as FetchLike;
    await expect(
      runUsage({ org: "ghost", token: "t" }, { config: CONFIG, fetchImpl, log: () => undefined }),
    ).rejects.toThrow(/Org "ghost" not found/);
  });

  it("rejects an invalid --days without making a request", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as FetchLike;
    await expect(
      runUsage(
        { org: "acme-corp", days: "-3", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/Invalid --days/);
    expect(called).toBe(false);
  });

  it("requires an org when none is given and no project is linked", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as FetchLike;
    await expect(
      runUsage(
        { token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined, cwd: "/tmp/boardwalk-no-link-xyz" },
      ),
    ).rejects.toThrow(/No org specified/);
    expect(called).toBe(false);
  });

  it("reads newer per-cut fields leniently (older backend omitting them still works)", async () => {
    // Backend without autonomy / cache / byModel — the parser defaults them.
    const { fetchImpl } = usageFetch({
      usage: {
        rangeDays: 14,
        totals: { runs: 3, tokensIn: 10, tokensOut: 5, runtimeSeconds: 120 },
        creditCents: null,
      },
    });
    const lines: string[] = [];
    await runUsage(
      { org: "acme-corp", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toMatch(/Autonomy\s+0% automated/);
    expect(out).toMatch(/Cache hit\s+0%/);
    expect(out).not.toContain("Top models");
  });
});

describe("formatAllowances", () => {
  it("renders real-unit gauges with a bar and ONE reset line — never a bare percentage", () => {
    const out = formatAllowances({
      plan: "solo",
      periodEnd: Date.UTC(2026, 7, 3),
      gauges: {
        agentHours: { included: 25, used: 14.2 },
        tokenPool: { includedCents: 1000, usedCents: 610 },
        searches: { included: 500, used: 312 },
      },
      spendCap: { capCents: 5000, usedCents: 1234 },
    }).join("\n");
    expect(out).toContain("Plan · Solo");
    expect(out).toContain("Managed inference");
    expect(out).toContain("14.2 of 25");
    expect(out).toContain("$6.10 of $10.00");
    expect(out).toContain("312 of 500");
    expect(out).toContain("$12.34 of $50.00");
    expect(out).toContain("Allowances reset August 3");
    expect(out).not.toMatch(/\d+%/);
  });

  it("is empty for plans without allowances and when the endpoint is absent", () => {
    expect(formatAllowances(null)).toEqual([]);
    expect(
      formatAllowances({
        plan: "legacy",
        periodEnd: null,
        gauges: null,
        spendCap: { capCents: null, usedCents: 0 },
      }),
    ).toEqual([]);
  });
});

describe("runUsage with allowances", () => {
  it("prints the plan block above the usage summary when the backend serves gauges", async () => {
    const { fetchImpl } = usageFetch({ usage: sample() }, sampleAllowances());
    const lines: string[] = [];
    await runUsage(
      { org: "acme-corp", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out.indexOf("Plan · Solo")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("Plan · Solo")).toBeLessThan(out.indexOf("Usage · acme-corp"));
  });

  it("merges allowances into --json output when present", async () => {
    const { fetchImpl } = usageFetch({ usage: sample() }, sampleAllowances());
    const lines: string[] = [];
    await runUsage(
      { org: "acme-corp", json: true, token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const parsed = JSON.parse(lines.join("\n")) as { allowances?: { plan?: string } };
    expect(parsed.allowances?.plan).toBe("solo");
  });
});
