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
}

/** A workflow's inbound webhook endpoint (GET /v1/orgs/:slug/workflows/:id/webhook). For `token`
 *  auth the secret rides in the URL path; for `signature` auth it is the HMAC key (sent in a header)
 *  and the URL stays tokenless. The secret VALUE is never returned by the read surface. */
export interface WorkflowWebhookInfo {
  url: string;
  auth: "token" | "signature";
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

export interface BoardwalkClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
   *  it ONCE. For `token` auth the returned `url` embeds the fresh secret (the full working URL); for
   *  `signature` auth `secret` is the new HMAC key and `url` stays tokenless. Null when no webhook trigger. */
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

  async triggerRun(orgSlug: string, workflowId: string, input: unknown): Promise<RunSummary> {
    const path = `/v1/orgs/${encodeURIComponent(orgSlug)}/workflows/${encodeURIComponent(workflowId)}/runs`;
    return this.runSummary(
      await this.request<unknown>("POST", path, input === undefined ? {} : { input }),
    );
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
  return { url: raw.url, auth: raw.auth };
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

/** Pull a human message out of the API's `{ error: { code, message } }` (or plain text) body. */
function apiErrorMessage(text: string, status: number): string {
  if (status === 401) return "Unauthorized — run `boardwalk login`, or set BOARDWALK_API_KEY.";
  if (status === 403) return "Forbidden — your account lacks permission for this org.";
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
    // not JSON
  }
  return text.length > 0 ? text.slice(0, 300) : "(no response body)";
}
