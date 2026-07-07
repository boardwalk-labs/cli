// SPDX-License-Identifier: MIT

// BoardwalkClient — a small hand-rolled REST client over Boardwalk's public platform API
// (deliberately no codegen client framework).
//
// Targets the workflow endpoints the deploy flow needs:
//   GET  /v1/orgs/:slug/workflows                       — list (resolve create-vs-update by name)
//   POST /v1/orgs/:slug/workflows/artifact-upload-url   — presign an upload for the program artifact
//   POST /v1/orgs/:slug/workflows                       — create (body: { artifact })
//   PATCH /v1/workflows/:id                             — update → new version (body: { artifact })
//   POST /v1/runs/:id/cancel                            — cancel a queued or in-flight run (204)
//
// Deploy is artifact-based: the CLI builds a content-addressed program tarball, uploads it straight
// to object storage via a presigned PUT (the CLI holds no storage credentials), then finalizes the
// version with a reference the server re-reads + verifies.
//
// Auth is a Bearer token (a session token from `boardwalk login`, OR a `bwk_…` API key).
// The API accepts both on the same header.

import { randomUUID } from "node:crypto";
import { type RunEvent, type RunStatus, runEventSchema } from "@boardwalk-labs/workflow";
import { CliError } from "./errors.js";
import { isRecord } from "./guards.js";
import { readSseFrames } from "./sse.js";
import type { FetchLike } from "./auth/pkce.js";

/** Terminal run statuses — a run here will emit no further events (used to stop `--follow`). */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

/** Whether a run status is terminal (no more events will arrive). */
export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as ReadonlySet<string>).has(status);
}

export interface WorkflowSummary {
  id: string;
  slug: string;
  currentVersionId: string | null;
}

export interface DeployResult {
  workflow: WorkflowSummary;
  version: { id: string; number: number };
}

/** The verified-artifact reference the finalize call records on the new version. */
export interface DeployArtifactRef {
  digest: string;
  size: number;
  entry: string;
  sdkVersion: string;
  lockfileDigest: string | null;
}

export interface RunSummary {
  id: string;
  workflowId: string;
  status: string;
  outcomeStatus: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** One row of the org runs list (GET /v1/orgs/:slug/runs) — the columns the CLI renders. */
export interface RunListItem {
  id: string;
  workflowId: string;
  workflowSlug: string | null;
  status: string;
  triggerKind: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Billed runtime (set at terminal); 0 while in flight. */
  runtimeSeconds: number;
}

/** A page of org runs + an opaque cursor for the next page (null when there are no more). */
export interface RunList {
  runs: RunListItem[];
  nextCursor: string | null;
}

/** A single run's detail (GET /v1/runs/:id) — the list row plus tokens + a curated error. */
export interface RunDetail extends RunListItem {
  outcomeStatus: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Curated failure cause for a failed run; null otherwise. */
  error: { code: string; message: string } | null;
}

/** A human-in-the-loop gate (durable suspension) — a run paused for a person to answer. */
export interface HumanInputItem {
  runId: string;
  key: string;
  prompt: string;
  /** The response form: `{ kind: "text" | "choice" | "multiselect", ... }`. */
  input: unknown;
  assignees: string[] | null;
  status: string;
  createdAt: number;
}

/** One enveloped run-telemetry frame: its run-global `cursor` + the validated v1 `RunEvent`. The
 *  cursor orders the log and is the `--follow` resume point (sent as `Last-Event-ID`). */
export interface RunEventRow {
  cursor: number;
  event: RunEvent;
}

/** A run's stored event log + whether the run is already terminal (so a caller can skip the stream). */
export interface RunEventSnapshot {
  events: RunEventRow[];
  done: boolean;
}

/** One row of the org's workflow list (GET /v1/orgs/:slug/workflows) — the at-a-glance projection. */
export interface WorkflowListItem {
  id: string;
  slug: string;
  title: string | null;
  triggerKinds: string[];
  updatedAt: number | null;
  /** The most recent run's status + time, or null when the workflow has never run. */
  lastRun: { status: string; at: number } | null;
  /** True when the workflow is disabled (paused): it rejects every trigger until re-enabled.
   *  Defaults false against an older backend that doesn't report `disabledAt`. */
  disabled: boolean;
}

/** A workflow version reference (GET /v1/workflows/:id → versions[]). */
export interface WorkflowVersionRef {
  id: string;
  number: number;
  createdAt: number;
}

/** A workflow's full detail (GET /v1/workflows/:id): identity + the current manifest + versions. */
export interface WorkflowDetail {
  id: string;
  slug: string;
  title: string | null;
  description: string | null;
  currentVersionId: string | null;
  triggers: string[];
  secrets: string[];
  /** The program entry file (e.g. `index.mjs`) when the API reports it. */
  entry: string | null;
  versions: WorkflowVersionRef[];
  /** True when the workflow is disabled (paused): it rejects every trigger until re-enabled. */
  disabled: boolean;
}

/** A workflow's inbound webhook endpoint (GET /v1/orgs/:slug/workflows/:id/webhook). The URL is
 *  the bare workflow endpoint — the secret is NEVER carried in the URL; it rides in a header per
 *  the trigger's verifier `preset` (`token` = X-Boardwalk-Token, `custom_header` = the named
 *  `header`, `signature` = HMAC in X-Boardwalk-Signature, or a provider dialect like `github`).
 *  The secret VALUE is never returned by the read surface. */
export interface WorkflowWebhookInfo {
  url: string;
  /** The coarse family the manifest declared. */
  auth: "token" | "signature";
  /** The resolved verification dialect; null from an older server (fall back on `auth`). */
  preset: string | null;
  /** Bearer header name for the `custom_header` preset; null otherwise. */
  header: string | null;
}

/** One secret in the org's catalog (GET /v1/orgs/:slug/secrets) — metadata only; VALUES are never
 *  returned by any surface. `last4` is a display hint computed server-side from the value. */
export interface SecretListItem {
  id: string;
  name: string;
  scope: string;
  kind: string;
  last4: string | null;
  description: string | null;
  createdAt: number | null;
}

/** A named environment (a config set a run/schedule targets by name; null = the org-level base). */
export interface EnvironmentItem {
  id: string;
  name: string;
  description: string | null;
}

export interface CreateEnvironmentInput {
  name: string;
  description?: string;
}

/** A NON-secret environment variable — the value IS returned on reads (injected into a run's
 *  process.env). `environmentId` null = the org-level base. */
export interface VariableItem {
  id: string;
  name: string;
  value: string;
  environmentId: string | null;
}

export interface CreateVariableInput {
  name: string;
  value: string;
  environmentId?: string | null;
}

/** Input for creating a secret. The raw `value` is staged into Secrets Manager server-side; only the
 *  ARN + a last-4 hint persist. */
export interface CreateSecretInput {
  name: string;
  value: string;
  scope: string;
  kind: string;
  description?: string;
}

/** One inference provider (GET /v1/orgs/:slug/inference-providers) — endpoint metadata only; the API
 *  key lives in Secrets Manager and is never returned (`hasApiKey` is the flag). */
export interface ProviderListItem {
  name: string;
  source: string;
  baseUrl: string | null;
  region: string | null;
  hasApiKey: boolean;
  billedByBoardwalk: boolean;
  createdAt: number | null;
}

/** Input for creating a BYO inference provider. `apiKey` (when given) is staged into Secrets Manager
 *  server-side; the value never persists in the row or returns in any read. */
export interface CreateProviderInput {
  name: string;
  source: string;
  baseUrl?: string;
  region?: string;
  apiVersion?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
}

/** One model in the managed-lane catalog (GET /v1/inference/rates) — display name + the all-in
 *  per-million-token prices (margin already applied) + context window when the lane reports it. */
export interface ModelListItem {
  id: string;
  name: string;
  inputPerMtok: number;
  outputPerMtok: number;
  contextTokens: number | null;
}

/** The managed-lane model catalog: the margin applied + every model an agent() call can run, priced.
 *  Models are featured-first (most capable lead), then the long tail alphabetically. */
export interface ModelList {
  marginPct: number;
  updatedAt: string | null;
  models: ModelListItem[];
}

/** The authenticated caller (GET /v1/me) — identity + every org they belong to. The subset the CLI
 *  renders for `boardwalk status`; memberships drive the "Orgs" line. */
export interface MeResult {
  user: { id: string; email: string; name: string | null };
  memberships: { slug: string | null; role: string; name: string | null }[];
}

/** A freshly-minted inference-gateway key: the plaintext token (shown once) + its expiry/id. */
export interface MintedInferenceKey {
  token: string;
  expiresAt: number | null;
  id: string | null;
}

/** A {label → token volume} line for the usage breakdowns. */
export interface UsageLine {
  label: string;
  tokens: number;
}

/** The org usage summary (GET /v1/orgs/:slug/usage) — the subset the CLI renders. Newer fields are
 *  read leniently (defaulted), so the CLI keeps working against an older / self-hosted backend. */
export interface UsageSummary {
  rangeDays: number;
  totals: { runs: number; tokensIn: number; tokensOut: number; runtimeSeconds: number };
  /** Effective available credit in cents; null when unavailable. */
  creditCents: number | null;
  /** Human-vs-automated run split. */
  autonomy: { humanRuns: number; automatedRuns: number };
  /** Prompt-cache efficiency: 0..1 hit rate + the read volume. */
  cache: { hitRate: number; cachedReadTokens: number };
  /** Heaviest models by token volume. */
  byModel: UsageLine[];
  /** Heaviest workflows by token volume. */
  byWorkflow: UsageLine[];
}

/** One plan-allowance gauge (real units): what the cycle includes vs what's been drawn. */
export interface AllowanceGauges {
  agentHours: { included: number; used: number };
  tokenPool: { includedCents: number; usedCents: number };
  searches: { included: number; used: number };
}

/** The org's plan + allowance summary (GET /v1/orgs/:slug/billing/allowances) — the subset the
 *  `boardwalk usage` gauges render. `gauges` is null on plans without allowances (free / legacy /
 *  enterprise). The whole endpoint is OPTIONAL: an older / self-hosted backend without it makes
 *  getAllowances return null and the CLI simply omits the plan block. */
export interface AllowancesSummary {
  plan: string;
  periodEnd: number | null;
  gauges: AllowanceGauges | null;
  spendCap: { capCents: number | null; usedCents: number };
}

export interface BoardwalkClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RunnerItem {
  id: string;
  poolId: string;
  name: string;
  labels: string[];
  os: string | null;
  arch: string | null;
  status: string;
  lastSeenAt: number | null;
}

function parseRunnerRow(row: unknown): RunnerItem | null {
  if (!isRecord(row)) return null;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    poolId: typeof row.poolId === "string" ? row.poolId : "",
    name: row.name,
    labels: Array.isArray(row.labels) ? row.labels.filter((l) => typeof l === "string") : [],
    os: typeof row.os === "string" ? row.os : null,
    arch: typeof row.arch === "string" ? row.arch : null,
    status: typeof row.status === "string" ? row.status : "unknown",
    lastSeenAt: typeof row.lastSeenAt === "number" ? row.lastSeenAt : null,
  };
}

export class BoardwalkClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: BoardwalkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async listWorkflows(orgSlug: string): Promise<WorkflowSummary[]> {
    const body = await this.request<{ workflows?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows`,
    );
    const rows = Array.isArray(body.workflows) ? body.workflows : [];
    return rows.filter(isWorkflowSummary);
  }

  /** List the org's workflows with the at-a-glance projection (title, triggers, last run) the
   *  `boardwalk workflows` table renders. Rows missing an id/slug are skipped (lenient). */
  async listWorkflowSummaries(orgSlug: string): Promise<WorkflowListItem[]> {
    const body = await this.request<{ workflows?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows`,
    );
    const rows = Array.isArray(body.workflows) ? body.workflows : [];
    const items: WorkflowListItem[] = [];
    for (const row of rows) {
      const parsed = parseWorkflowListItem(row);
      if (parsed !== null) items.push(parsed);
    }
    return items;
  }

  /** Fetch one workflow's detail by id (GET /v1/workflows/:id): identity + current manifest +
   *  versions. The endpoint is keyed by id (the org is resolved from it), so no slug is needed. */
  async getWorkflowDetail(id: string): Promise<WorkflowDetail> {
    const body = await this.request<unknown>("GET", `/v1/workflows/${encodeURIComponent(id)}`);
    return parseWorkflowDetail(body);
  }

  /** Delete a workflow by id (DELETE /v1/workflows/:id). Returns 204; idempotent server-side. */
  async deleteWorkflow(id: string): Promise<void> {
    await this.request<undefined>("DELETE", `/v1/workflows/${encodeURIComponent(id)}`);
  }

  /** Disable a workflow by id (POST /v1/workflows/:id/disable). The reversible pause: it rejects
   *  every trigger until re-enabled; in-flight + queued runs are left alone. Idempotent server-side. */
  async disableWorkflow(id: string): Promise<void> {
    await this.request<undefined>("POST", `/v1/workflows/${encodeURIComponent(id)}/disable`);
  }

  /** Re-enable a disabled workflow by id (POST /v1/workflows/:id/enable). Idempotent server-side. */
  async enableWorkflow(id: string): Promise<void> {
    await this.request<undefined>("POST", `/v1/workflows/${encodeURIComponent(id)}/enable`);
  }

  /** List one workflow's recent runs (GET /v1/orgs/:slug/workflows/:workflowId/runs). */
  async listWorkflowRuns(
    orgSlug: string,
    workflowId: string,
    opts: { status?: string; limit?: number } = {},
  ): Promise<RunList> {
    const params = new URLSearchParams();
    if (opts.status !== undefined) params.set("status", opts.status);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    const body = await this.request<unknown>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/runs${query.length > 0 ? `?${query}` : ""}`,
    );
    return this.runList(body);
  }

  /** Fetch a workflow's webhook URL + auth mode (GET /v1/orgs/:slug/workflows/:id/webhook). Returns
   *  null when the workflow has no enabled webhook trigger. The secret value is never returned here. */
  async getWorkflowWebhook(
    orgSlug: string,
    workflowId: string,
  ): Promise<WorkflowWebhookInfo | null> {
    const body = await this.request<unknown>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/webhook`,
    );
    return parseWebhookInfo(isRecord(body) ? body.webhook : null);
  }

  /** Rotate a workflow's webhook secret (POST .../webhook/rotate; admin-gated server-side) and return
   *  it ONCE as `secret` — the URL stays the bare endpoint (the secret is never in the URL; the
   *  sender delivers it per the verifier preset). Null when no webhook trigger. */
  async rotateWorkflowWebhook(
    orgSlug: string,
    workflowId: string,
  ): Promise<(WorkflowWebhookInfo & { secret: string }) | null> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/webhook/rotate`,
    );
    const webhook = isRecord(body) ? body.webhook : null;
    const info = parseWebhookInfo(webhook);
    if (info === null) return null;
    if (!isRecord(webhook) || typeof webhook.secret !== "string") {
      throw new CliError("The API returned an unexpected webhook response shape.");
    }
    return { ...info, secret: webhook.secret };
  }

  /** List the org's secrets — metadata only (names/scope/kind/last4), never values. */
  async listSecrets(orgSlug: string): Promise<SecretListItem[]> {
    const body = await this.request<{ secrets?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/secrets`,
    );
    const rows = Array.isArray(body.secrets) ? body.secrets : [];
    const out: SecretListItem[] = [];
    for (const row of rows) {
      const parsed = parseSecretRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  /** Create (or set) a secret — the raw value is staged server-side; only metadata returns. */
  async createSecret(orgSlug: string, input: CreateSecretInput): Promise<SecretListItem> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/secrets`,
      input,
    );
    const secret = isRecord(body) ? parseSecretRow(body.secret) : null;
    if (secret === null)
      throw new CliError("The API returned an unexpected secret response shape.");
    return secret;
  }

  /** Delete a secret by id (DELETE /v1/secrets/:id). The id-keyed endpoint resolves the org. */
  async deleteSecret(id: string): Promise<void> {
    await this.request<undefined>("DELETE", `/v1/secrets/${encodeURIComponent(id)}`);
  }

  // ---- self-hosted runners ----

  /** One-step runner registration (`boardwalk runner start`): returns the show-once bwkr_ token. */
  async registerRunner(
    orgSlug: string,
    input: {
      pool: string;
      name: string;
      labels?: string[];
      os?: string;
      arch?: string;
      version?: string;
    },
  ): Promise<{ runnerId: string; runnerToken: string }> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/runners`,
      input,
    );
    if (isRecord(body) && isRecord(body.runner) && typeof body.runner.id === "string") {
      const token = body.runnerToken;
      if (typeof token === "string" && token.length > 0) {
        return { runnerId: body.runner.id, runnerToken: token };
      }
    }
    throw new CliError("The API returned an unexpected runner registration response shape.");
  }

  /** Mint a one-time registration token for a pool (created if absent) — the two-step fleet flow. */
  async mintRunnerToken(
    orgSlug: string,
    pool: string,
  ): Promise<{ registrationToken: string; expiresAt: number }> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/runner-pools/${encodeURIComponent(pool)}/registration-tokens`,
    );
    if (
      isRecord(body) &&
      typeof body.registrationToken === "string" &&
      typeof body.expiresAt === "number"
    ) {
      return { registrationToken: body.registrationToken, expiresAt: body.expiresAt };
    }
    throw new CliError("The API returned an unexpected registration-token response shape.");
  }

  async listRunners(orgSlug: string): Promise<RunnerItem[]> {
    const body = await this.request<{ runners?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/runners`,
    );
    const rows = Array.isArray(body.runners) ? body.runners : [];
    const out: RunnerItem[] = [];
    for (const row of rows) {
      const parsed = parseRunnerRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  async listRunnerPools(orgSlug: string): Promise<{ id: string; name: string }[]> {
    const body = await this.request<{ pools?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/runner-pools`,
    );
    const rows = Array.isArray(body.pools) ? body.pools : [];
    const out: { id: string; name: string }[] = [];
    for (const row of rows) {
      if (isRecord(row) && typeof row.id === "string" && typeof row.name === "string") {
        out.push({ id: row.id, name: row.name });
      }
    }
    return out;
  }

  async drainRunner(runnerId: string): Promise<void> {
    await this.request<unknown>("POST", `/v1/runners/${encodeURIComponent(runnerId)}/drain`);
  }

  async deregisterRunner(runnerId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/v1/runners/${encodeURIComponent(runnerId)}`);
  }

  /** List the org's named environments (id/name/description). */
  async listEnvironments(orgSlug: string): Promise<EnvironmentItem[]> {
    const body = await this.request<{ environments?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/environments`,
    );
    const rows = Array.isArray(body.environments) ? body.environments : [];
    const out: EnvironmentItem[] = [];
    for (const row of rows) {
      const parsed = parseEnvironmentRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  /** Create a named environment. */
  async createEnvironment(
    orgSlug: string,
    input: CreateEnvironmentInput,
  ): Promise<EnvironmentItem> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/environments`,
      input,
    );
    const env = isRecord(body) ? parseEnvironmentRow(body.environment) : null;
    if (env === null) {
      throw new CliError("The API returned an unexpected environment response shape.");
    }
    return env;
  }

  /** Delete an environment by id (DELETE /v1/environments/:id). */
  async deleteEnvironment(id: string): Promise<void> {
    await this.request<undefined>("DELETE", `/v1/environments/${encodeURIComponent(id)}`);
  }

  /** List the org's NON-secret variables — values INCLUDED (they're non-secret), across all
   *  environments (each carries its `environmentId`; null = the org base). */
  async listVariables(orgSlug: string): Promise<VariableItem[]> {
    const body = await this.request<{ variables?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/env-variables`,
    );
    const rows = Array.isArray(body.variables) ? body.variables : [];
    const out: VariableItem[] = [];
    for (const row of rows) {
      const parsed = parseVariableRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  /** Create (or set) a non-secret variable. `environmentId` null/omitted = the org base. */
  async createVariable(orgSlug: string, input: CreateVariableInput): Promise<VariableItem> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/env-variables`,
      input,
    );
    const variable = isRecord(body) ? parseVariableRow(body.variable) : null;
    if (variable === null) {
      throw new CliError("The API returned an unexpected variable response shape.");
    }
    return variable;
  }

  /** Delete a variable by id (DELETE /v1/env-variables/:id). */
  async deleteVariable(id: string): Promise<void> {
    await this.request<undefined>("DELETE", `/v1/env-variables/${encodeURIComponent(id)}`);
  }

  /** List the org's inference providers — endpoint metadata only; API keys are never returned. */
  async listProviders(orgSlug: string): Promise<ProviderListItem[]> {
    const body = await this.request<{ providers?: unknown }>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/inference-providers`,
    );
    const rows = Array.isArray(body.providers) ? body.providers : [];
    const out: ProviderListItem[] = [];
    for (const row of rows) {
      const parsed = parseProviderRow(row);
      if (parsed !== null) out.push(parsed);
    }
    return out;
  }

  /** Create a BYO inference provider — any `apiKey` is staged server-side; only metadata returns. */
  async createProvider(orgSlug: string, input: CreateProviderInput): Promise<ProviderListItem> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/inference-providers`,
      input,
    );
    const provider = isRecord(body) ? parseProviderRow(body.provider) : null;
    if (provider === null) {
      throw new CliError("The API returned an unexpected provider response shape.");
    }
    return provider;
  }

  /** Delete an inference provider by name (DELETE /v1/orgs/:slug/inference-providers/:name). */
  async deleteProvider(orgSlug: string, name: string): Promise<void> {
    await this.request<undefined>(
      "DELETE",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/inference-providers/${encodeURIComponent(name)}`,
    );
  }

  async createWorkflow(orgSlug: string, artifact: DeployArtifactRef): Promise<DeployResult> {
    return this.deployResult(
      await this.request<unknown>("POST", `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows`, {
        artifact,
      }),
    );
  }

  async updateWorkflow(id: string, artifact: DeployArtifactRef): Promise<DeployResult> {
    return this.deployResult(
      await this.request<unknown>("PATCH", `/v1/workflows/${encodeURIComponent(id)}`, { artifact }),
    );
  }

  /** Request a presigned PUT for a program artifact (the CLI then uploads the tarball directly). */
  async getArtifactUploadUrl(
    orgSlug: string,
    input: { digest: string; size: number },
  ): Promise<{ uploadUrl: string; contentType: string }> {
    const body = await this.request<{ uploadUrl?: unknown; contentType?: unknown }>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/artifact-upload-url`,
      input,
    );
    if (typeof body.uploadUrl !== "string" || typeof body.contentType !== "string") {
      throw new CliError("The API returned an unexpected upload-url response shape.");
    }
    return { uploadUrl: body.uploadUrl, contentType: body.contentType };
  }

  /** Upload the artifact bytes straight to storage via the presigned PUT. The Content-Type MUST
   *  equal the one signed into the URL, or the store rejects the PUT. No auth header — the URL
   *  carries the signature. */
  async uploadArtifact(uploadUrl: string, contentType: string, bytes: Uint8Array): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
    } catch (err) {
      throw new CliError(
        "Could not upload the program artifact to storage.",
        err instanceof Error ? err.message : undefined,
      );
    }
    if (!res.ok) {
      throw new CliError(`Artifact upload failed (${String(res.status)}).`, await safeText(res));
    }
  }

  async triggerRun(
    orgSlug: string,
    workflowId: string,
    input: unknown,
    environment?: string,
  ): Promise<RunSummary> {
    const path = `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/runs`;
    const body: Record<string, unknown> = {};
    if (input !== undefined) body.input = input;
    // `environment` is the NAME; the server resolves it to the environment's id (omitted = org base).
    if (environment !== undefined) body.environment = environment;
    return this.runSummary(await this.request<unknown>("POST", path, body));
  }

  async getRun(runId: string): Promise<RunSummary> {
    return this.runSummary(
      await this.request<unknown>("GET", `/v1/runs/${encodeURIComponent(runId)}`),
    );
  }

  /** List the org's recent runs, newest first. Optional `status` filter + `limit` (server-clamped). */
  async listOrgRuns(
    orgSlug: string,
    opts: { status?: string; limit?: number } = {},
  ): Promise<RunList> {
    const params = new URLSearchParams();
    if (opts.status !== undefined) params.set("status", opts.status);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const query = params.toString();
    const body = await this.request<unknown>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/runs${query.length > 0 ? `?${query}` : ""}`,
    );
    return this.runList(body);
  }

  /** Fetch one run's detail. The endpoint resolves the org from the run id, so no slug is needed. */
  async getRunDetail(runId: string): Promise<RunDetail> {
    const body = await this.request<unknown>("GET", `/v1/runs/${encodeURIComponent(runId)}`);
    return this.runDetail(body);
  }

  /** A run's human-in-the-loop gates (GET /v1/runs/:id/inputs), optionally filtered by status. */
  async listRunInputs(runId: string, status?: string): Promise<HumanInputItem[]> {
    const query = status !== undefined ? `?status=${encodeURIComponent(status)}` : "";
    const body = await this.request<unknown>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/inputs${query}`,
    );
    return parseInputs(body);
  }

  /** The org-wide inbox of pending gates (GET /v1/orgs/:slug/inputs). */
  async listOrgInputs(orgSlug: string): Promise<HumanInputItem[]> {
    const body = await this.request<unknown>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/inputs`,
    );
    return parseInputs(body);
  }

  /** Answer a gate (POST /v1/runs/:id/inputs/:key); the run resumes once its batch is answered. The
   *  endpoint resolves the org from the run id. `submission` is `{ value }` or `{ values, other? }`. */
  async respondToInput(
    runId: string,
    key: string,
    submission: { value?: string; values?: string[]; other?: string },
  ): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/v1/runs/${encodeURIComponent(runId)}/inputs/${encodeURIComponent(key)}`,
      submission,
    );
  }

  /**
   * The run's stored event log as a one-shot JSON snapshot (GET /v1/runs/:id/events). `sinceCursor`
   * returns only events after that cursor (for incremental fetches); omitted ⇒ the whole log. The
   * endpoint resolves the org from the run id, so no slug is needed.
   */
  async getRunEvents(runId: string, sinceCursor?: number): Promise<RunEventSnapshot> {
    const query = sinceCursor !== undefined ? `?since=${String(sinceCursor)}` : "";
    const body = await this.request<unknown>(
      "GET",
      `/v1/runs/${encodeURIComponent(runId)}/events${query}`,
    );
    if (!isRecord(body) || !Array.isArray(body.events)) {
      throw new CliError("The API returned an unexpected run-events response shape.");
    }
    const events: RunEventRow[] = [];
    for (const row of body.events) {
      const parsed = parseEnvelopedEvent(row);
      if (parsed !== null) events.push(parsed);
    }
    return { events, done: body.done === true };
  }

  /**
   * Live-tail the run's events over SSE (GET /v1/runs/:id/stream), yielding each enveloped event as
   * it arrives. `fromCursor` resumes after a known cursor (sent as `Last-Event-ID`). The server
   * self-closes the stream when the run goes terminal, ending the iteration; `signal` aborts it
   * early (e.g. Ctrl-C). Yields nothing and returns on a body-less response.
   */
  async *streamRunEvents(
    runId: string,
    opts: { fromCursor?: number; signal?: AbortSignal } = {},
  ): AsyncGenerator<RunEventRow> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "text/event-stream",
    };
    if (opts.fromCursor !== undefined && opts.fromCursor > 0) {
      headers["Last-Event-ID"] = String(opts.fromCursor);
    }
    const init: RequestInit = { method: "GET", headers };
    if (opts.signal !== undefined) init.signal = opts.signal;

    const path = `/v1/runs/${encodeURIComponent(runId)}/stream`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new CliError(
        `Could not reach the Boardwalk API at ${this.baseUrl}.`,
        err instanceof Error ? err.message : undefined,
      );
    }
    if (!res.ok) {
      throw new CliError(
        `GET ${path} failed (${String(res.status)}).`,
        apiErrorMessage(await safeText(res).then((t) => t ?? ""), res.status),
        res.status,
      );
    }
    if (res.body === null) return;

    for await (const frame of readSseFrames(res.body)) {
      // `stream_error` is the one transport-level frame outside the RunEvent contract (see the
      // backend SSE codec) — surface it as a failure rather than trying to parse it as an event.
      if (frame.event === "stream_error") {
        throw new CliError(
          "The run event stream ended with an error.",
          streamErrorMessage(frame.data),
        );
      }
      const event = parseRunEvent(safeJsonParse(frame.data));
      if (event === null) continue;
      const cursor = Number.parseInt(frame.id ?? "", 10);
      yield { cursor: Number.isFinite(cursor) ? cursor : 0, event };
    }
  }

  /**
   * Cancel a run. Idempotent server-side (a terminal/already-cancelling run is a no-op); the
   * endpoint resolves the org from the run id, so no org slug is needed. Returns 204 No Content.
   */
  async cancelRun(runId: string): Promise<void> {
    await this.request<undefined>("POST", `/v1/runs/${encodeURIComponent(runId)}/cancel`);
  }

  /**
   * Mint an inference-only key for the gateway (scope inference:invoke, a default spend cap), the
   * credential `boardwalk dev` injects so the engine's default `boardwalk` provider works. The
   * server fixes scopes/cap/expiry — no request body. Returns the plaintext token ONCE.
   */
  async mintInferenceKey(orgSlug: string): Promise<MintedInferenceKey> {
    const body = await this.request<unknown>(
      "POST",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/inference-keys`,
    );
    return this.mintedInferenceKey(body);
  }

  /** Fetch the authenticated caller (GET /v1/me) — proves the token is valid and yields the
   *  identity + org memberships `boardwalk status` renders. Accepts both a session token and a
   *  `bwk_…` API key (the GET is not session-only). */
  async getMe(): Promise<MeResult> {
    return this.me(await this.request<unknown>("GET", "/v1/me"));
  }

  /** Fetch the managed-lane model catalog (GET /v1/inference/rates): every model an agent() call can
   *  run on the managed lane, with all-in per-million-token prices + context window. The endpoint is
   *  public + org-independent (no slug); the bearer header rides along but is ignored. */
  async listModels(): Promise<ModelList> {
    return this.modelList(await this.request<unknown>("GET", "/v1/inference/rates"));
  }

  /**
   * Fetch the org's plan-allowance gauges, or null when the backend doesn't serve them (an older
   * or self-hosted deployment — the endpoint is additive, so absence is not an error).
   */
  async getAllowances(orgSlug: string): Promise<AllowancesSummary | null> {
    let body: unknown;
    try {
      body = await this.request<unknown>(
        "GET",
        `/v1/orgs/${encodeURIComponent(orgSlug)}/billing/allowances`,
      );
    } catch (err) {
      if (err instanceof CliError && err.status === 404) return null;
      throw err;
    }
    return parseAllowances(body);
  }

  /** Fetch the org's usage summary over `days` (server default when omitted, capped at 90). */
  async getUsage(orgSlug: string, days?: number): Promise<UsageSummary> {
    const query = days !== undefined ? `?days=${String(days)}` : "";
    const body = await this.request<unknown>(
      "GET",
      `/v1/orgs/${encodeURIComponent(orgSlug)}/usage${query}`,
    );
    return this.usageSummary(body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (UNSAFE_METHODS.has(method)) headers["Idempotency-Key"] = randomUUID();

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new CliError(
        `Could not reach the Boardwalk API at ${this.baseUrl}.`,
        err instanceof Error ? err.message : undefined,
      );
    }

    const text = await res.text();
    if (!res.ok) {
      throw new CliError(
        `${method} ${path} failed (${String(res.status)}).`,
        apiErrorMessage(text, res.status),
        res.status,
      );
    }
    // The only two casts left in this file, confined to the deserialization boundary: a parsed JSON
    // body is `unknown`, and callers re-validate its shape with `isRecord` + the `is*` guards below
    // before reading any field. `T` is just the caller's expected shape, never trusted at runtime.
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`The API returned a non-JSON response for ${method} ${path}.`);
    }
  }

  private deployResult(body: unknown): DeployResult {
    if (isRecord(body) && isWorkflowSummary(body.workflow) && isVersion(body.version)) {
      return { workflow: body.workflow, version: body.version };
    }
    throw new CliError("The API returned an unexpected workflow response shape.");
  }

  private runSummary(body: unknown): RunSummary {
    if (isRecord(body) && isRunSummary(body.run)) return body.run;
    throw new CliError("The API returned an unexpected run response shape.");
  }

  /** Validate the `{ runs, nextCursor }` envelope, reading each row leniently (rows missing an
   *  id/status are skipped, so a partial/older response still lists what it can). */
  private runList(body: unknown): RunList {
    if (!isRecord(body) || !Array.isArray(body.runs)) {
      throw new CliError("The API returned an unexpected runs response shape.");
    }
    const runs: RunListItem[] = [];
    for (const row of body.runs) {
      const parsed = parseRunRow(row);
      if (parsed !== null) runs.push(parsed);
    }
    return { runs, nextCursor: typeof body.nextCursor === "string" ? body.nextCursor : null };
  }

  /** Validate the `{ run }` envelope and read its columns + tokens + curated error. */
  private runDetail(body: unknown): RunDetail {
    const run = isRecord(body) ? body.run : undefined;
    const base = parseRunRow(run);
    if (!isRecord(run) || base === null) {
      throw new CliError("The API returned an unexpected run response shape.");
    }
    return {
      ...base,
      outcomeStatus: typeof run.outcomeStatus === "string" ? run.outcomeStatus : null,
      tokensIn: numOr(run.tokensIn, 0),
      tokensOut: numOr(run.tokensOut, 0),
      error: parseRunError(run.error),
    };
  }

  /** Validate the `{ user, memberships }` envelope, reading the fields the status command shows.
   *  The user's email is the one required field (no identity without it); memberships are read
   *  leniently — a row missing a role is skipped, so a partial/older response still lists what it can. */
  private me(body: unknown): MeResult {
    if (!isRecord(body) || !isRecord(body.user) || typeof body.user.email !== "string") {
      throw new CliError("The API returned an unexpected /v1/me response shape.");
    }
    const user = body.user;
    const memberships: MeResult["memberships"] = [];
    if (Array.isArray(body.memberships)) {
      for (const m of body.memberships) {
        if (!isRecord(m) || typeof m.role !== "string") continue;
        memberships.push({
          slug: typeof m.slug === "string" ? m.slug : null,
          role: m.role,
          name: typeof m.name === "string" ? m.name : null,
        });
      }
    }
    return {
      user: {
        id: typeof user.id === "string" ? user.id : "",
        email: typeof user.email === "string" ? user.email : "",
        name: typeof user.name === "string" ? user.name : null,
      },
      memberships,
    };
  }

  /** Validate the `{ marginPct, updatedAt, models }` rates payload, reading each model row leniently
   *  (rows missing an id/name are skipped) so an older / self-hosted backend still lists what it can. */
  private modelList(body: unknown): ModelList {
    if (!isRecord(body) || !Array.isArray(body.models)) {
      throw new CliError("The API returned an unexpected models response shape.");
    }
    const models: ModelListItem[] = [];
    for (const row of body.models) {
      const parsed = parseModelRow(row);
      if (parsed !== null) models.push(parsed);
    }
    return {
      marginPct: numOr(body.marginPct, 0),
      updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : null,
      models,
    };
  }

  private mintedInferenceKey(body: unknown): MintedInferenceKey {
    if (isRecord(body) && typeof body.token === "string" && body.token.length > 0) {
      const apiKey: Record<string, unknown> = isRecord(body.apiKey) ? body.apiKey : {};
      return {
        token: body.token,
        expiresAt: typeof apiKey.expiresAt === "number" ? apiKey.expiresAt : null,
        id: typeof apiKey.id === "string" ? apiKey.id : null,
      };
    }
    throw new CliError("The API returned an unexpected inference-key response shape.");
  }

  /** Validate the `{ usage }` envelope and read the fields the CLI renders. Lenient on the newer
   *  per-cut fields (defaulted), so an older / self-hosted backend still produces a usable summary. */
  private usageSummary(body: unknown): UsageSummary {
    if (!isRecord(body) || !isRecord(body.usage)) {
      throw new CliError("The API returned an unexpected usage response shape.");
    }
    const u = body.usage;
    const totals = isRecord(u.totals) ? u.totals : {};
    const autonomy = isRecord(u.autonomy) ? u.autonomy : {};
    const cache = isRecord(u.cache) ? u.cache : {};
    return {
      rangeDays: numOr(u.rangeDays, 0),
      totals: {
        runs: numOr(totals.runs, 0),
        tokensIn: numOr(totals.tokensIn, 0),
        tokensOut: numOr(totals.tokensOut, 0),
        runtimeSeconds: numOr(totals.runtimeSeconds, 0),
      },
      creditCents: typeof u.creditCents === "number" ? u.creditCents : null,
      autonomy: {
        humanRuns: numOr(autonomy.humanRuns, 0),
        automatedRuns: numOr(autonomy.automatedRuns, 0),
      },
      cache: {
        hitRate: numOr(cache.hitRate, 0),
        cachedReadTokens: numOr(cache.totalCachedRead, 0),
      },
      byModel: usageLines(u.byModel, "model"),
      byWorkflow: usageLines(u.byWorkflowUsage, "workflowSlug"),
    };
  }
}

/** A number field, or a fallback when it's missing/non-numeric. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Lenient parse of the allowances payload; null when the shape isn't recognizable. */
function parseAllowances(body: unknown): AllowancesSummary | null {
  if (!isRecord(body) || typeof body.plan !== "string") return null;
  const g = isRecord(body.gauges) ? body.gauges : null;
  const numPair = (v: unknown, a: string, b: string): [number, number] | null => {
    if (!isRecord(v)) return null;
    const x = v[a];
    const y = v[b];
    return typeof x === "number" && typeof y === "number" ? [x, y] : null;
  };
  let gauges: AllowanceGauges | null = null;
  if (g !== null) {
    const hours = numPair(g.agentHours, "included", "used");
    const pool = numPair(g.tokenPool, "includedCents", "usedCents");
    const searches = numPair(g.searches, "included", "used");
    if (hours !== null && pool !== null && searches !== null) {
      gauges = {
        agentHours: { included: hours[0], used: hours[1] },
        tokenPool: { includedCents: pool[0], usedCents: pool[1] },
        searches: { included: searches[0], used: searches[1] },
      };
    }
  }
  const cap = isRecord(body.spendCap) ? body.spendCap : {};
  return {
    plan: body.plan,
    periodEnd: typeof body.periodEnd === "number" ? body.periodEnd : null,
    gauges,
    spendCap: {
      capCents: typeof cap.capCents === "number" ? cap.capCents : null,
      usedCents: numOr(cap.usedCents, 0),
    },
  };
}

/** Parse a `{ inputs: [...] }` response into `HumanInputItem[]`, skipping malformed rows. */
function parseInputs(body: unknown): HumanInputItem[] {
  if (!isRecord(body) || !Array.isArray(body.inputs)) {
    throw new CliError("The API returned an unexpected inputs response shape.");
  }
  const out: HumanInputItem[] = [];
  for (const row of body.inputs) {
    if (!isRecord(row) || typeof row.runId !== "string" || typeof row.key !== "string") continue;
    out.push({
      runId: row.runId,
      key: row.key,
      prompt: typeof row.prompt === "string" ? row.prompt : "",
      input: row.input ?? null,
      assignees: Array.isArray(row.assignees)
        ? row.assignees.filter((a): a is string => typeof a === "string")
        : null,
      status: typeof row.status === "string" ? row.status : "pending",
      createdAt: numOr(row.createdAt, 0),
    });
  }
  return out;
}

/** Read a serialized run row into a `RunListItem`, or null when it lacks an id/status. Shared by the
 *  runs-list and single-run parsers (the latter layers tokens + error on top). */
function parseRunRow(row: unknown): RunListItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.status !== "string") return null;
  return {
    id: row.id,
    workflowId: typeof row.workflowId === "string" ? row.workflowId : "",
    workflowSlug: typeof row.workflowSlug === "string" ? row.workflowSlug : null,
    status: row.status,
    triggerKind: typeof row.triggerKind === "string" ? row.triggerKind : null,
    createdAt: numOr(row.createdAt, 0),
    startedAt: typeof row.startedAt === "number" ? row.startedAt : null,
    completedAt: typeof row.completedAt === "number" ? row.completedAt : null,
    runtimeSeconds: numOr(row.runtimeSeconds, 0),
  };
}

/** Read a run's curated `{ code, message }` error, or null when there's no usable message. */
function parseRunError(value: unknown): { code: string; message: string } | null {
  if (!isRecord(value) || typeof value.message !== "string" || value.message.length === 0) {
    return null;
  }
  return { code: typeof value.code === "string" ? value.code : "ERROR", message: value.message };
}

/** Read a usage breakdown array into `{ label, tokens }` lines, taking the label from `labelKey`.
 *  Rows missing a string label or numeric `tokens` are skipped. */
function usageLines(value: unknown, labelKey: string): UsageLine[] {
  if (!Array.isArray(value)) return [];
  const lines: UsageLine[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const label = row[labelKey];
    if (typeof label !== "string" || typeof row.tokens !== "number") continue;
    lines.push({ label, tokens: row.tokens });
  }
  return lines;
}

/** Validate a parsed JSON value into a typed v1 `RunEvent` via the SDK's schema (no cast — the
 *  schema IS the contract). Returns null for anything that isn't a well-formed event. */
function parseRunEvent(value: unknown): RunEvent | null {
  const parsed = runEventSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Read a `{ cursor, event }` snapshot row into a `RunEventRow`, or null when malformed. */
function parseEnvelopedEvent(row: unknown): RunEventRow | null {
  if (!isRecord(row) || typeof row.cursor !== "number") return null;
  const event = parseRunEvent(row.event);
  return event === null ? null : { cursor: row.cursor, event };
}

/** Best-effort `JSON.parse` for an SSE `data:` payload (never throws; undefined on bad JSON). */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Pull a human message out of a `stream_error` frame's `{ message }` payload. */
function streamErrorMessage(data: string): string | undefined {
  const parsed = safeJsonParse(data);
  if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.length > 0) {
    return parsed.message;
  }
  return data.length > 0 ? data.slice(0, 300) : undefined;
}

/** Read a workflow list row into a `WorkflowListItem`, or null when it lacks an id/slug. Lenient on
 *  the projection fields so an older / self-hosted backend still lists what it can. */
function parseWorkflowListItem(row: unknown): WorkflowListItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.slug !== "string") return null;
  return {
    id: row.id,
    slug: row.slug,
    title: typeof row.title === "string" ? row.title : null,
    triggerKinds: stringArray(row.triggerKinds),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
    lastRun: parseLastRun(row.lastRun),
    disabled: typeof row.disabledAt === "number",
  };
}

/** Read the `{ status, at }` last-run projection, or null when absent/malformed. */
function parseLastRun(value: unknown): { status: string; at: number } | null {
  if (!isRecord(value) || typeof value.status !== "string" || typeof value.at !== "number") {
    return null;
  }
  return { status: value.status, at: value.at };
}

/** Validate the `{ workflow, manifest, program, versions }` detail envelope into a `WorkflowDetail`,
 *  reading the manifest projection leniently. The workflow id/slug is the one hard requirement. */
function parseWorkflowDetail(body: unknown): WorkflowDetail {
  const workflow = isRecord(body) ? body.workflow : undefined;
  if (!isRecord(workflow) || typeof workflow.id !== "string" || typeof workflow.slug !== "string") {
    throw new CliError("The API returned an unexpected workflow response shape.");
  }
  const manifest = isRecord(body) && isRecord(body.manifest) ? body.manifest : {};
  const program = isRecord(body) && isRecord(body.program) ? body.program : {};
  const permissions = isRecord(manifest.permissions) ? manifest.permissions : {};
  const versions: WorkflowVersionRef[] = [];
  if (isRecord(body) && Array.isArray(body.versions)) {
    for (const v of body.versions) {
      if (isRecord(v) && typeof v.id === "string" && typeof v.number === "number") {
        versions.push({ id: v.id, number: v.number, createdAt: numOr(v.createdAt, 0) });
      }
    }
  }
  return {
    id: workflow.id,
    slug: workflow.slug,
    title: typeof manifest.title === "string" ? manifest.title : null,
    description: typeof manifest.description === "string" ? manifest.description : null,
    currentVersionId:
      typeof workflow.currentVersionId === "string" ? workflow.currentVersionId : null,
    triggers: triggerKinds(manifest.triggers),
    secrets: secretNames(permissions.secrets),
    entry: typeof program.entry === "string" ? program.entry : null,
    versions,
    disabled: typeof workflow.disabledAt === "number",
  };
}

/** Map a manifest `triggers: [{ kind }]` array to its kind strings (lenient). */
function triggerKinds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const kinds: string[] = [];
  for (const t of value) {
    if (isRecord(t) && typeof t.kind === "string") kinds.push(t.kind);
  }
  return kinds;
}

/** Map a manifest `permissions.secrets: [{ name }]` array to its name strings (lenient). */
function secretNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const s of value) {
    if (isRecord(s) && typeof s.name === "string") names.push(s.name);
  }
  return names;
}

/** Read an array of strings, dropping non-string entries; [] when not an array. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Read a secret catalog row into a `SecretListItem`, or null when it lacks an id/name. */
/** Validate the API's `webhook` field. Returns null for an absent or malformed value (the workflow
 *  has no webhook trigger, or an older/odd response) — callers map null to an actionable message. */
function parseWebhookInfo(raw: unknown): WorkflowWebhookInfo | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.url !== "string" || raw.url.length === 0) return null;
  if (raw.auth !== "token" && raw.auth !== "signature") return null;
  return {
    url: raw.url,
    auth: raw.auth,
    preset: typeof raw.preset === "string" && raw.preset.length > 0 ? raw.preset : null,
    header: typeof raw.header === "string" && raw.header.length > 0 ? raw.header : null,
  };
}

function parseSecretRow(row: unknown): SecretListItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    scope: typeof row.scope === "string" ? row.scope : "",
    kind: typeof row.kind === "string" ? row.kind : "",
    last4: typeof row.last4 === "string" ? row.last4 : null,
    description: typeof row.description === "string" ? row.description : null,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
  };
}

function parseEnvironmentRow(row: unknown): EnvironmentItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    description: typeof row.description === "string" ? row.description : null,
  };
}

function parseVariableRow(row: unknown): VariableItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    value: typeof row.value === "string" ? row.value : "",
    environmentId: typeof row.environmentId === "string" ? row.environmentId : null,
  };
}

/** Read a model catalog row into a `ModelListItem`, or null when it lacks an id/name. The context
 *  window is optional upstream; absent ⇒ null. */
function parseModelRow(row: unknown): ModelListItem | null {
  if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    inputPerMtok: numOr(row.inputPerMtok, 0),
    outputPerMtok: numOr(row.outputPerMtok, 0),
    contextTokens: typeof row.contextTokens === "number" ? row.contextTokens : null,
  };
}

/** Read an inference-provider row into a `ProviderListItem`, or null when it lacks a name/source. */
function parseProviderRow(row: unknown): ProviderListItem | null {
  if (!isRecord(row) || typeof row.name !== "string" || typeof row.source !== "string") return null;
  return {
    name: row.name,
    source: row.source,
    baseUrl: typeof row.baseUrl === "string" ? row.baseUrl : null,
    region: typeof row.region === "string" ? row.region : null,
    hasApiKey: row.hasApiKey === true,
    billedByBoardwalk: row.billedByBoardwalk === true,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
  };
}

function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.slug === "string" &&
    (value.currentVersionId === null || typeof value.currentVersionId === "string")
  );
}

function isVersion(value: unknown): value is { id: string; number: number } {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.number === "number";
}

function isRunSummary(value: unknown): value is RunSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.workflowId === "string" &&
    typeof value.status === "string" &&
    (value.outcomeStatus === null || typeof value.outcomeStatus === "string") &&
    (value.startedAt === null || typeof value.startedAt === "number") &&
    (value.completedAt === null || typeof value.completedAt === "number")
  );
}

/** Best-effort read of a response body for an error message (never throws). */
async function safeText(res: Response): Promise<string | undefined> {
  try {
    const t = await res.text();
    return t.length > 0 ? t.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pull a human message out of the API's `{ error: { code, message } }` (or plain text) body.
 *
 * A 401 is authentication — the remedy is invariant (re-authenticate), and that guidance beats a raw
 * backend reason like "invalid signature", so 401 keeps its hint. For everything else — notably 403,
 * where the remedy VARIES (missing token scope vs. role shortfall vs. session-only vs. not-a-member) —
 * surface the backend's SPECIFIC message verbatim; the backend computes it on purpose. A hardcoded
 * "your account lacks permission for this org" discarded that and actively misled: an org OWNER whose
 * CLI token merely lacked a scope was told they lacked org access. The generic 403 line survives only
 * as the no-body fallback (e.g. an upstream/proxy 403 with an empty or non-JSON body).
 */
function apiErrorMessage(text: string, status: number): string {
  if (status === 401) return "Unauthorized — run `boardwalk login`, or set BOARDWALK_API_KEY.";
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body)) {
      if (
        isRecord(body.error) &&
        typeof body.error.message === "string" &&
        body.error.message.length > 0
      ) {
        return body.error.message;
      }
      if (typeof body.message === "string" && body.message.length > 0) return body.message;
    }
  } catch {
    // not JSON — fall through to a status hint or the raw text
  }
  if (status === 403) return "Forbidden — your account lacks permission for this org.";
  return text.length > 0 ? text.slice(0, 300) : "(no response body)";
}
