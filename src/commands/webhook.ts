// SPDX-License-Identifier: MIT

// `boardwalk webhook <workflow>` — work with a workflow's inbound webhook URL from the terminal:
//   • webhook <ref>            → print the webhook URL + verification scheme (no secret).
//   • webhook <ref> --rotate   → regenerate the secret and reveal it ONCE.
//
// The URL is the bare workflow endpoint — the secret is NEVER in the URL. It rides in a header,
// per the trigger's verifier preset: `token` sends it verbatim in X-Boardwalk-Token,
// `custom_header` in a caller-named header, `signature` as an HMAC of the raw body in
// X-Boardwalk-Signature, and the provider presets (github/stripe/slack/linear) verify that
// provider's own signing scheme. <ref> is a workflow id (a ULID) or slug; a slug needs an org
// (--org or a linked project). --rotate is admin-gated server-side and invalidates the previous
// secret, so the sender must be reconfigured afterwards.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { WorkflowWebhookInfo } from "../client.js";
import { resolveOrgClient, requireOrg, elevationHint } from "../org_client.js";
import { resolveLog } from "../log.js";
import { resolveWorkflowId } from "../workflow_ref.js";
import type { FetchLike } from "../auth/pkce.js";

export interface WebhookOptions {
  ref: string;
  org?: string | undefined;
  /** Regenerate the secret and reveal the full working URL once (admin-gated). */
  rotate?: boolean | undefined;
  json?: boolean | undefined;
  token?: string | undefined;
}

export interface WebhookDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
  /** Directory to look for a `.boardwalk` project link in (defaults to the process cwd). */
  cwd?: string;
}

export async function runWebhook(opts: WebhookOptions, deps: WebhookDeps): Promise<void> {
  const log = resolveLog(deps);
  const ref = opts.ref.trim();
  const { client, org } = await resolveOrgClient(deps, opts);
  const orgSlug = requireOrg(org);
  const id = await resolveWorkflowId(client, org, ref);

  if (opts.rotate === true) {
    const rotated = await client.rotateWorkflowWebhook(orgSlug, id).catch((err: unknown): never => {
      throw elevationHint(err, "Rotating a webhook secret");
    });
    if (rotated === null) throw noWebhookError(ref);
    if (opts.json === true) {
      log(JSON.stringify({ webhook: rotated }, null, 2));
      return;
    }
    for (const line of formatRotated(ref, rotated)) log(line);
    return;
  }

  const info = await client.getWorkflowWebhook(orgSlug, id);
  if (info === null) throw noWebhookError(ref);
  if (opts.json === true) {
    log(JSON.stringify({ webhook: info }, null, 2));
    return;
  }
  for (const line of formatInfo(ref, info)) log(line);
}

function noWebhookError(ref: string): CliError {
  return new CliError(
    `Workflow "${ref}" has no webhook trigger.`,
    'Add { "kind": "webhook", "auth": "token" } to the descriptor\'s triggers and redeploy.',
  );
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

/** The trigger's effective verification dialect: the stored preset, else the manifest family. */
function effectivePreset(info: WorkflowWebhookInfo): string {
  return info.preset ?? info.auth;
}

/** One-line description of the scheme, for the info view's Auth row. */
function schemeLine(info: WorkflowWebhookInfo): string {
  switch (effectivePreset(info)) {
    case "token":
      return "token — secret sent verbatim in the X-Boardwalk-Token header";
    case "custom_header":
      return `token — secret sent verbatim in the ${info.header ?? "<configured>"} header`;
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
    default:
      return `${effectivePreset(info)} (see the dashboard's Triggers tab)`;
  }
}

/** Paste guidance for the freshly revealed secret, per scheme. */
function sendLine(info: WorkflowWebhookInfo): string {
  switch (effectivePreset(info)) {
    case "token":
      return "Send it verbatim in the X-Boardwalk-Token header with every POST.";
    case "custom_header":
      return `Send it verbatim in the ${info.header ?? "<configured>"} header with every POST.`;
    case "signature":
      return "Sign the raw request body (HMAC-SHA256) and send X-Boardwalk-Signature: sha256=<hex>.";
    default:
      // Provider presets usually verify the PROVIDER's signing secret (pasted in the dashboard);
      // this freshly rotated value replaces it, so the sender must be configured to sign with it.
      return `Configure it as the sender's signing secret; requests verify per the ${effectivePreset(info)} scheme.`;
  }
}

/** Render `webhook <ref>` (no secret): the endpoint + verification scheme + how to reveal a secret. */
export function formatInfo(ref: string, info: WorkflowWebhookInfo): string[] {
  return [
    `Webhook · ${ref}`,
    "",
    field("Endpoint", info.url),
    field("Auth", schemeLine(info)),
    "",
    "The secret is never in the URL and never shown here. Rotate + reveal one with:",
    `  boardwalk webhook ${ref} --rotate`,
  ];
}

/** Render `webhook <ref> --rotate`: the endpoint + freshly revealed secret, show-once. */
export function formatRotated(
  ref: string,
  rotated: WorkflowWebhookInfo & { secret: string },
): string[] {
  return [
    `✓ Rotated the webhook secret for ${ref}.`,
    "",
    field("Endpoint", rotated.url),
    field("Secret", rotated.secret),
    "",
    "Save the secret now. It is shown only once, and the previous secret is invalid.",
    sendLine(rotated),
  ];
}

/** A "  Label   value" detail row (matches the `workflows` detail layout). */
function field(label: string, value: string): string {
  return `  ${label.padEnd(10)} ${value}`;
}
