// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import { filterModels, formatModelList, runModelsList, runModelsShow } from "./models.js";
import type { ModelListItem } from "../client.js";
import type { CliConfig } from "../config.js";
import type { FetchLike } from "../auth/pkce.js";

const CONFIG: CliConfig = {
  apiBaseUrl: "https://api.x",
  issuerUrl: "https://api.x",
  oauthClientId: "boardwalk-cli",
  loopbackPort: 53682,
  configDir: "/tmp/does-not-matter",
};

const MODELS: ModelListItem[] = [
  {
    id: "anthropic/claude-opus-4.8",
    name: "Claude Opus 4.8",
    inputPerMtok: 3.15,
    outputPerMtok: 15.75,
    contextTokens: 200_000,
  },
  {
    id: "openai/gpt-5.5",
    name: "GPT-5.5",
    inputPerMtok: 1.05,
    outputPerMtok: 2.1,
    contextTokens: null,
  },
  {
    id: "mistralai/mistral-large",
    name: "Mistral Large",
    inputPerMtok: 0.5,
    outputPerMtok: 0.5,
    contextTokens: 128_000,
  },
];

interface Call {
  url: string;
  method: string;
}

function ratesFetch(models: ModelListItem[] = MODELS): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: init?.method ?? "GET" });
    return Promise.resolve(new Response(JSON.stringify({ marginPct: 5, updatedAt: "t", models })));
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe("filterModels", () => {
  it("returns every model when there is no query", () => {
    expect(filterModels(MODELS, undefined)).toHaveLength(3);
    expect(filterModels(MODELS, "  ")).toHaveLength(3);
  });

  it("matches id or display name, case-insensitively", () => {
    expect(filterModels(MODELS, "OPUS").map((m) => m.id)).toEqual(["anthropic/claude-opus-4.8"]);
    expect(filterModels(MODELS, "mistral").map((m) => m.id)).toEqual(["mistralai/mistral-large"]);
  });
});

describe("formatModelList", () => {
  it("renders a priced table with the margin note + compact context", () => {
    const out = formatModelList(MODELS, { marginPct: 5, all: true, search: undefined }).join("\n");
    expect(out).toContain("5% margin included");
    expect(out).toMatch(/MODEL\s+ID\s+INPUT\s+OUTPUT\s+CONTEXT/);
    expect(out).toContain("Claude Opus 4.8");
    expect(out).toContain("$3.15");
    expect(out).toContain("200K");
    expect(out).toContain("—"); // gpt-5.5 reports no context window
  });

  it("caps the default view and hints at the remainder", () => {
    const many: ModelListItem[] = Array.from({ length: 42 }, (_, i) => ({
      id: `v/m${String(i)}`,
      name: `M${String(i)}`,
      inputPerMtok: 1,
      outputPerMtok: 1,
      contextTokens: null,
    }));
    const out = formatModelList(many, { marginPct: 5, all: false, search: undefined }).join("\n");
    expect(out).toContain("showing 30");
    expect(out).toContain("… and 12 more");
  });

  it("pads sub-dollar prices to ≥2 decimals, keeping sub-cent precision", () => {
    const priced: ModelListItem[] = [
      { id: "a/p70", name: "P70", inputPerMtok: 0.7, outputPerMtok: 0.5, contextTokens: null },
      { id: "a/sub", name: "Sub", inputPerMtok: 0.035, outputPerMtok: 12.5, contextTokens: null },
    ];
    const out = formatModelList(priced, { marginPct: 0, all: true, search: undefined }).join("\n");
    expect(out).toContain("$0.70"); // was "$0.7"
    expect(out).toContain("$0.50"); // was "$0.5"
    expect(out).toContain("$0.035"); // sub-cent precision preserved
    expect(out).toContain("$12.50"); // dollar-scale unchanged
    expect(out).not.toMatch(/\$0\.7\D/); // never the unpadded "$0.7" (next char is a digit in "$0.70")
    expect(out).not.toMatch(/\$0\.5\D/); // never the unpadded "$0.5"
  });

  it("reports no matches for a search that hits nothing", () => {
    expect(formatModelList([], { marginPct: 5, all: false, search: "zzz" })).toEqual([
      `No models match "zzz".`,
    ]);
  });
});

describe("runModelsList", () => {
  it("GETs the public rates endpoint and renders the table", async () => {
    const { fetchImpl, calls } = ratesFetch();
    const lines: string[] = [];
    await runModelsList({ token: "t" }, { config: CONFIG, fetchImpl, log: (l) => lines.push(l) });
    expect(calls[0]?.url).toBe("https://api.x/v1/inference/rates");
    expect(lines.join("\n")).toContain("Claude Opus 4.8");
  });

  it("--json prints the filtered catalog", async () => {
    const { fetchImpl } = ratesFetch();
    const lines: string[] = [];
    await runModelsList(
      { token: "t", json: true, search: "opus" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const parsed = JSON.parse(lines.join("\n")) as { marginPct: number; models: { id: string }[] };
    expect(parsed.marginPct).toBe(5);
    expect(parsed.models.map((m) => m.id)).toEqual(["anthropic/claude-opus-4.8"]);
  });
});

describe("runModelsShow", () => {
  it("prints a model's detail when supported", async () => {
    const { fetchImpl } = ratesFetch();
    const lines: string[] = [];
    await runModelsShow(
      { id: "openai/gpt-5.5", token: "t" },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    const out = lines.join("\n");
    expect(out).toContain("GPT-5.5");
    expect(out).toContain("openai/gpt-5.5");
    expect(out).toContain("$1.05");
  });

  it("--json reports supported:false for an unknown id", async () => {
    const { fetchImpl } = ratesFetch();
    const lines: string[] = [];
    await runModelsShow(
      { id: "ghost/model", token: "t", json: true },
      { config: CONFIG, fetchImpl, log: (l) => lines.push(l) },
    );
    expect(JSON.parse(lines.join("\n"))).toEqual({
      model: "ghost/model",
      supported: false,
      rate: null,
    });
  });

  it("throws a helpful error for an unknown id in table mode", async () => {
    const { fetchImpl } = ratesFetch();
    await expect(
      runModelsShow(
        { id: "ghost/model", token: "t" },
        { config: CONFIG, fetchImpl, log: () => undefined },
      ),
    ).rejects.toThrow(/not available on the managed lane/);
  });
});
