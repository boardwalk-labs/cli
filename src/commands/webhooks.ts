// SPDX-License-Identifier: MIT

// `boardwalk webhooks` — the org's inbound webhook endpoints. A webhook is created ONCE, then any
// number of workflows attach to it with `{ "kind": "webhook", "name": <name> }` in their descriptor
// triggers; every attached workflow runs on every delivery.
//
//   • webhooks list              → name / URL / verification (secrets are never shown)
//   • webhooks create <name>     → create one; the signing secret is revealed ONCE
//   • webhooks rotate <name>     → new signing secret, revealed ONCE (the old one stops working)
//   • webhooks delete <name>     → remove it and its secret (requires --yes)
//
// The secret is NEVER in the URL — it rides in a header per the verification preset. create/rotate/
// delete are admin-gated server-side, so they need an ELEVATED login (`login --scopes admin`).

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { WebhookInfo } from "../client.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import { readAllStdin } from "../stdin.js";
import type { FetchLike } from "../auth/pkce.js";

export interface WebhooksListOptions {
  org?: string | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WebhooksCreateOptions extends WebhooksListOptions {
  name: string;
  description?: string | undefined;
  /** Verification dialect; defaults to `token` (a bearer secret we mint). */
  preset?: string | undefined;
  /** Header name, required by the `custom_header` preset. */
  header?: string | undefined;
  /** A sender-owned signing secret to store instead of minting one (`-` reads stdin). */
  secret?: string | undefined;
}

export interface WebhooksRotateOptions extends WebhooksListOptions {
  name: string;
}

export interface WebhooksDeleteOptions extends WebhooksListOptions {
  name: string;
  yes?: boolean | undefined;
}

export interface WebhooksDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  cwd?: string;
}

export async function runWebhooksList(
  opts: WebhooksListOptions,
  deps: WebhooksDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const webhooks = await client.listWebhooks(requireOrg(org));
  if (opts.json === true) {
    log(JSON.stringify({ webhooks }, null, 2));
    return;
  }
  for (const line of formatList(webhooks)) log(line);
}

export async function runWebhooksCreate(
  opts: WebhooksCreateOptions,
  deps: WebhooksDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const name = opts.name.trim();
  if (name.length === 0) throw new CliError("A webhook name is required.");
  const { client, org } = await resolveOrgClient(deps, opts);

  const secret = await resolveSecret(opts.secret);
  const created = await client
    .createWebhook(requireOrg(org), {
      name,
      preset: opts.preset ?? "token",
      ...(opts.description !== undefined ? { description: opts.description } : {}),
      ...(opts.header !== undefined ? { header: opts.header } : {}),
      ...(secret !== undefined ? { secret } : {}),
    })
    .catch((err: unknown): never => {
      throw elevationHint(err, "Creating a webhook");
    });

  if (opts.json === true) {
    log(JSON.stringify({ webhook: created }, null, 2));
    return;
  }
  for (const line of formatCreated(created)) log(line);
}

export async function runWebhooksRotate(
  opts: WebhooksRotateOptions,
  deps: WebhooksDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const target = await findByName(client, requireOrg(org), opts.name);
  const rotated = await client.rotateWebhook(target.id).catch((err: unknown): never => {
    throw elevationHint(err, "Rotating a webhook secret");
  });

  if (opts.json === true) {
    log(JSON.stringify({ webhook: rotated }, null, 2));
    return;
  }
  for (const line of formatRotated(rotated)) log(line);
}

export async function runWebhooksDelete(
  opts: WebhooksDeleteOptions,
  deps: WebhooksDeps,
): Promise<void> {
  const log = resolveLog(deps);
  const { client, org } = await resolveOrgClient(deps, opts);
  const target = await findByName(client, requireOrg(org), opts.name);
  if (opts.yes !== true) {
    throw new CliError(
      `This deletes the webhook "${target.name}" and its signing secret.`,
      "Re-run with --yes to confirm. Workflows attached to it will show as not connected.",
    );
  }
  await client.deleteWebhook(target.id).catch((err: unknown): never => {
    throw elevationHint(err, "Deleting a webhook");
  });
  log(`✓ Deleted the webhook "${target.name}".`);
}

/** Resolve a NAME to its row — the CLI addresses webhooks the way descriptors do. */
async function findByName(
  client: { listWebhooks(orgSlug: string): Promise<WebhookInfo[]> },
  orgSlug: string,
  rawName: string,
): Promise<WebhookInfo> {
  const name = rawName.trim();
  const webhooks = await client.listWebhooks(orgSlug);
  const found = webhooks.find((w) => w.name === name);
  if (found === undefined) {
    throw new CliError(
      `No webhook named "${name}" in this org.`,
      webhooks.length === 0
        ? "Create one with: boardwalk webhooks create <name>"
        : `Existing webhooks: ${webhooks.map((w) => w.name).join(", ")}`,
    );
  }
  return found;
}

/** `-` reads the secret from stdin, so it never lands in shell history. */
async function resolveSecret(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value !== "-") return value;
  const piped = (await readAllStdin()).trim();
  if (piped.length === 0) throw new CliError("No secret on stdin.");
  return piped;
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

/** One-line description of how a webhook verifies its deliveries. */
export function schemeLine(webhook: WebhookInfo): string {
  switch (webhook.preset) {
    case "token":
      return "token — secret sent verbatim in the X-Boardwalk-Token header";
    case "custom_header":
      return `token — secret sent verbatim in the ${webhook.header ?? "<configured>"} header`;
    case "signature":
      return "signature — HMAC-SHA256 of the raw body in X-Boardwalk-Signature: sha256=<hex>";
    case "github":
      return "GitHub signature — X-Hub-Signature-256 over the raw body";
    case "stripe":
      return "Stripe signature — Stripe-Signature (timestamped, 5 min replay window)";
    case "slack":
      return "Slack signature — X-Slack-Signature (timestamped, 5 min replay window)";
    case "linear":
      return "Linear signature — Linear-Signature over the raw body";
    case "sentry":
      return "Sentry signature — Sentry-Hook-Signature over the raw body";
    case "pagerduty":
      return "PagerDuty signature — X-PagerDuty-Signature over the raw body";
    case "standard_webhooks":
      return "Standard Webhooks — webhook-id / webhook-timestamp / webhook-signature";
    default:
      return `${webhook.preset} (see the dashboard's Connections page)`;
  }
}

/** Paste guidance for a freshly revealed secret. */
function sendLine(webhook: WebhookInfo): string {
  switch (webhook.preset) {
    case "token":
      return "Send it verbatim in the X-Boardwalk-Token header with every POST.";
    case "custom_header":
      return `Send it verbatim in the ${webhook.header ?? "<configured>"} header with every POST.`;
    case "signature":
      return "Sign the raw request body (HMAC-SHA256) and send X-Boardwalk-Signature: sha256=<hex>.";
    default:
      return `Configure it as the sender's signing secret; requests verify per the ${webhook.preset} scheme.`;
  }
}

export function formatList(webhooks: readonly WebhookInfo[]): string[] {
  if (webhooks.length === 0) {
    return [
      "No webhooks yet.",
      "",
      "Create one, point a sender at its URL, then attach workflows by name:",
      "  boardwalk webhooks create my-hook",
    ];
  }
  const lines: string[] = [];
  for (const webhook of webhooks) {
    lines.push(webhook.name);
    lines.push(field("Endpoint", webhook.url));
    lines.push(field("Auth", schemeLine(webhook)));
    if (webhook.description !== null) lines.push(field("About", webhook.description));
    lines.push(field("Attach", `{ "kind": "webhook", "name": "${webhook.name}" }`));
    lines.push("");
  }
  lines.pop();
  return lines;
}

export function formatCreated(webhook: WebhookInfo & { secret: string }): string[] {
  return [
    `✓ Created the webhook "${webhook.name}".`,
    "",
    field("Endpoint", webhook.url),
    field("Secret", webhook.secret),
    "",
    "Save the secret now — it is shown only once.",
    sendLine(webhook),
    "",
    `Attach a workflow by adding { "kind": "webhook", "name": "${webhook.name}" } to its triggers.`,
  ];
}

export function formatRotated(webhook: WebhookInfo & { secret: string }): string[] {
  return [
    `✓ Rotated the signing secret for "${webhook.name}".`,
    "",
    field("Endpoint", webhook.url),
    field("Secret", webhook.secret),
    "",
    "Save the secret now. It is shown only once, and the previous secret is invalid.",
    sendLine(webhook),
  ];
}

/** A "  Label   value" detail row (matches the `workflows` detail layout). */
function field(label: string, value: string): string {
  return `  ${label.padEnd(10)} ${value}`;
}
