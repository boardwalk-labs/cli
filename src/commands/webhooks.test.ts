// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import type { WebhookInfo } from "../client.js";
import { formatList, formatCreated, formatRotated, schemeLine } from "./webhooks.js";

function webhook(overrides: Partial<WebhookInfo> = {}): WebhookInfo {
  return {
    id: "wh1",
    name: "stripe-prod",
    url: "https://webhook.boardwalk.sh/v1/webhooks/wh1",
    description: null,
    preset: "token",
    header: null,
    ...overrides,
  };
}

describe("formatList", () => {
  it("tells a first-time user how to get one, with the create command", () => {
    const out = formatList([]).join("\n");
    expect(out).toContain("No webhooks yet");
    expect(out).toContain("boardwalk webhooks create");
  });

  it("shows the endpoint, the scheme, and the exact descriptor snippet to attach with", () => {
    const out = formatList([webhook()]).join("\n");
    expect(out).toContain("stripe-prod");
    expect(out).toContain("https://webhook.boardwalk.sh/v1/webhooks/wh1");
    expect(out).toContain("X-Boardwalk-Token");
    expect(out).toContain('{ "kind": "webhook", "name": "stripe-prod" }');
  });

  it("prints no secret VALUE — the list surface never receives one", () => {
    const out = formatList([webhook(), webhook({ id: "wh2", name: "sentry" })]).join("\n");
    // The word appears in the scheme description ("secret sent verbatim in …"); a minted value
    // would carry the `whk_` prefix, and there is nowhere for one to come from.
    expect(out).not.toMatch(/whk_|whsec_/);
    expect(out).not.toContain("Secret ");
  });

  it("includes a description when the webhook has one", () => {
    expect(formatList([webhook({ description: "Stripe production" })]).join("\n")).toContain(
      "Stripe production",
    );
  });
});

describe("formatCreated / formatRotated", () => {
  it("reveals the secret once and says so, plus how to send it", () => {
    const out = formatCreated({ ...webhook(), secret: "whk_abc" }).join("\n");
    expect(out).toContain("whk_abc");
    expect(out).toContain("shown only once");
    expect(out).toContain("X-Boardwalk-Token");
    expect(out).toContain('{ "kind": "webhook", "name": "stripe-prod" }');
  });

  it("warns on rotate that the previous secret is dead", () => {
    const out = formatRotated({ ...webhook(), secret: "whk_new" }).join("\n");
    expect(out).toContain("whk_new");
    expect(out).toContain("previous secret is invalid");
  });

  it("tells a provider-signed preset to configure the secret on the sender", () => {
    const out = formatCreated({ ...webhook({ preset: "stripe" }), secret: "whsec_x" }).join("\n");
    expect(out).toContain("sender's signing secret");
  });

  it("names the custom header rather than the default one", () => {
    const out = formatCreated({
      ...webhook({ preset: "custom_header", header: "x-acme-token" }),
      secret: "whk_abc",
    }).join("\n");
    expect(out).toContain("x-acme-token");
    expect(out).not.toContain("X-Boardwalk-Token");
  });
});

describe("schemeLine", () => {
  it("describes every shipped preset without falling through", () => {
    const presets = [
      "token",
      "custom_header",
      "signature",
      "github",
      "stripe",
      "slack",
      "linear",
      "sentry",
      "pagerduty",
      "standard_webhooks",
    ];
    for (const preset of presets) {
      expect(schemeLine(webhook({ preset }))).not.toContain("see the dashboard");
    }
  });

  it("falls back readably for a preset this CLI build predates", () => {
    expect(schemeLine(webhook({ preset: "shopify" }))).toContain("shopify");
  });
});
