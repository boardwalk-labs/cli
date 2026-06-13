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
import type { FetchLike } from "./auth/pkce.js";

export interface WorkflowSummary {
  id: string;
  name: string;
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

/** A freshly-minted inference-gateway key: the plaintext token (shown once) + its expiry/id. */
export interface MintedInferenceKey {
  token: string;
  expiresAt: number | null;
  id: string | null;
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
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new CliError(`The API returned a non-JSON response for ${method} ${path}.`);
    }
  }

  private deployResult(body: unknown): DeployResult {
    if (typeof body === "object" && body !== null) {
      const b = body as { workflow?: unknown; version?: unknown };
      if (isWorkflowSummary(b.workflow) && isVersion(b.version)) {
        return { workflow: b.workflow, version: b.version };
      }
    }
    throw new CliError("The API returned an unexpected workflow response shape.");
  }

  private runSummary(body: unknown): RunSummary {
    if (typeof body === "object" && body !== null) {
      const run = (body as { run?: unknown }).run;
      if (isRunSummary(run)) return run;
    }
    throw new CliError("The API returned an unexpected run response shape.");
  }

  private mintedInferenceKey(body: unknown): MintedInferenceKey {
    if (typeof body === "object" && body !== null) {
      const b = body as { token?: unknown; apiKey?: unknown };
      if (typeof b.token === "string" && b.token.length > 0) {
        const apiKey =
          typeof b.apiKey === "object" && b.apiKey !== null
            ? (b.apiKey as { id?: unknown; expiresAt?: unknown })
            : {};
        return {
          token: b.token,
          expiresAt: typeof apiKey.expiresAt === "number" ? apiKey.expiresAt : null,
          id: typeof apiKey.id === "string" ? apiKey.id : null,
        };
      }
    }
    throw new CliError("The API returned an unexpected inference-key response shape.");
  }
}

function isWorkflowSummary(value: unknown): value is WorkflowSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    (v.currentVersionId === null || typeof v.currentVersionId === "string")
  );
}

function isVersion(value: unknown): value is { id: string; number: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.number === "number";
}

function isRunSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.workflowId === "string" &&
    typeof v.status === "string" &&
    (v.outcomeStatus === null || typeof v.outcomeStatus === "string") &&
    (v.startedAt === null || typeof v.startedAt === "number") &&
    (v.completedAt === null || typeof v.completedAt === "number")
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
    if (typeof body === "object" && body !== null) {
      const err = (body as { error?: unknown }).error;
      if (typeof err === "object" && err !== null) {
        const message = (err as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
      const topMessage = (body as { message?: unknown }).message;
      if (typeof topMessage === "string" && topMessage.length > 0) return topMessage;
    }
  } catch {
    // not JSON
  }
  return text.length > 0 ? text.slice(0, 300) : "(no response body)";
}
