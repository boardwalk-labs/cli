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
import { CliError } from "./errors.js";
import { isRecord } from "./guards.js";
import type { FetchLike } from "./auth/pkce.js";

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
  workflowName: string | null;
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
      byWorkflow: usageLines(u.byWorkflowUsage, "workflowName"),
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
    workflowName: typeof row.workflowName === "string" ? row.workflowName : null,
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

function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
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
