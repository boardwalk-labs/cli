// SPDX-License-Identifier: MIT

// `boardwalk cancel <runId>` — stop a queued or in-flight run.
//
// Thin front-end over POST /v1/runs/:id/cancel (idempotent server-side). The endpoint resolves the
// org from the run id, so no --org / project link is needed — just a run id + a token. After the
// cancel we read the run back to report what actually happened, since cancellation is async:
//   • `cancelling` — a running worker is being signalled; it will finalize as `cancelled`.
//   • `cancelled`  — a queued/sleeping run flipped straight to terminal.
//   • already terminal (`completed`/`failed`) — the cancel was a harmless no-op.

import { CliError } from "../errors.js";
import type { CliConfig } from "../config.js";
import { CredentialStore } from "../credentials.js";
import { resolveApiTarget } from "../auth/resolve.js";
import { BoardwalkClient } from "../client.js";
import type { FetchLike } from "../auth/pkce.js";

export interface CancelOptions {
  runId: string;
  token?: string | undefined;
}

export interface CancelDeps {
  config: CliConfig;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export async function runCancel(opts: CancelOptions, deps: CancelDeps): Promise<void> {
  const log =
    deps.log ??
    ((line: string): void => {
      console.log(line);
    });

  const runId = opts.runId.trim();
  if (runId.length === 0) {
    throw new CliError("A run id is required.", "Usage: boardwalk cancel <runId>");
  }

  const store = CredentialStore.atConfigDir(deps.config.configDir);
  const { token, baseUrl } = await resolveApiTarget({
    config: deps.config,
    store,
    tokenFlag: opts.token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const client = new BoardwalkClient({
    baseUrl,
    token,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  await client.cancelRun(runId);

  // Read the run back so we can report the resulting status (cancel is async + idempotent).
  const run = await client.getRun(runId);
  log(cancelMessage(run.status, runId));
}

/** Human-readable line describing a run's status right after a cancel request. */
export function cancelMessage(status: string, runId: string): string {
  switch (status) {
    case "cancelled":
      return `✓ run ${runId} cancelled.`;
    case "cancelling":
      return `… run ${runId} is cancelling — the worker is being stopped; it will finalize as cancelled.`;
    case "completed":
    case "failed":
      return `• run ${runId} already finished (${status}) — nothing to cancel.`;
    default:
      return `… cancel requested for run ${runId} (status: ${status}).`;
  }
}
