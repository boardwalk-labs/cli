// SPDX-License-Identifier: MIT

// `boardwalk webhook <workflow>` — work with a workflow's inbound webhook URL from the terminal:
//   • webhook <ref>            → print the webhook URL + auth mode (no secret).
//   • webhook <ref> --rotate   → regenerate the secret and reveal the full working URL ONCE.
//
// For `token` auth the secret rides IN the URL path, so --rotate prints the full URL you paste into
// the source app (Linear, GitHub, Stripe); there is no header to set. For `signature` auth the secret
// is the HMAC key you sign the request body with. <ref> is a workflow id (a ULID) or slug; a slug
// needs an org (--org or a linked project). --rotate is admin-gated server-side and invalidates the
// previous secret, so the sender must be reconfigured afterwards.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import type { WorkflowWebhookInfo } from "../client.js";
import { resolveOrgClient } from "../org_client.js";
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
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });
  const ref = opts.ref.trim();
  const { client, org } = await resolveOrgClient(deps, opts);
  const orgSlug = requireOrg(org);
  const id = await resolveWorkflowId(client, org, ref);

  if (opts.rotate === true) {
    const rotated = await client.rotateWorkflowWebhook(orgSlug, id).catch((err: unknown): never => {
      throw elevationHint(err);
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

function requireOrg(org: string | undefined): string {
  if (org === undefined || org.length === 0) {
    throw new CliError(
      "No org specified.",
      "Pass --org <slug>, or run from a linked project (deploy/run links one).",
    );
  }
  return org;
}

function noWebhookError(ref: string): CliError {
  return new CliError(
    `Workflow "${ref}" has no webhook trigger.`,
    'Add { kind: "webhook", auth: "token" } to meta.triggers and redeploy.',
  );
}

/** Map a 403 (non-admin) to the elevation hint, matching the other admin-gated commands. */
function elevationHint(err: unknown): unknown {
  if (err instanceof CliError && err.status === 403) {
    return new CliError(
      "Rotating a webhook secret needs an elevated session.",
      "Run `boardwalk login --scopes admin` (you must be an org admin), then retry.",
    );
  }
  return err;
}

// ── formatters (pure — exported for tests) ──────────────────────────────────────────────────────

/** Render `webhook <ref>` (no secret): the endpoint + auth mode + how to reveal the working secret. */
export function formatInfo(ref: string, info: WorkflowWebhookInfo): string[] {
  if (info.auth === "token") {
    return [
      `Webhook · ${ref}`,
      "",
      field("Endpoint", `${info.url}/<token>`),
      field("Auth", "token (secret in the URL)"),
      "",
      "The full URL embeds a secret token and is shown only once. Reveal it with:",
      `  boardwalk webhook ${ref} --rotate`,
    ];
  }
  return [
    `Webhook · ${ref}`,
    "",
    field("URL", info.url),
    field("Auth", "signature (HMAC, X-Boardwalk-Signature)"),
    "",
    "Sign the raw request body with the signing secret. Generate one with:",
    `  boardwalk webhook ${ref} --rotate`,
  ];
}

/** Render `webhook <ref> --rotate`: the freshly revealed URL/secret, show-once, with paste guidance. */
export function formatRotated(
  ref: string,
  rotated: WorkflowWebhookInfo & { secret: string },
): string[] {
  if (rotated.auth === "token") {
    return [
      `✓ Generated the webhook URL for ${ref}.`,
      "",
      `  ${rotated.url}`,
      "",
      "Save it now. It is shown only once, and the previous URL stops working.",
      "Paste it into your app's webhook setting (Linear, GitHub, Stripe).",
    ];
  }
  return [
    `✓ Rotated the signing secret for ${ref}.`,
    "",
    field("URL", rotated.url),
    field("Secret", rotated.secret),
    "",
    "Save the secret now. It is shown only once, and the previous secret is invalid.",
    "Sign the raw request body (HMAC-SHA256) and send X-Boardwalk-Signature: sha256=<hex>.",
  ];
}

/** A "  Label   value" detail row (matches the `workflows` detail layout). */
function field(label: string, value: string): string {
  return `  ${label.padEnd(10)} ${value}`;
}
