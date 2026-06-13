// SPDX-License-Identifier: MIT

// CliError — a user-facing error. The top-level handler prints `message` (and `hint`, if any) to
// stderr and exits non-zero, WITHOUT a stack trace. Throw this for expected failures (not
// authenticated, file missing, API rejected the request); let unexpected errors surface their stack.

export class CliError extends Error {
  readonly hint: string | undefined;
  /** HTTP status, when this error came from an API response (lets callers branch on e.g. 404). */
  readonly status: number | undefined;
  /** Process exit code override (default 1) — e.g. 130 for a cancelled `dev` run. */
  readonly exitCode: number | undefined;

  constructor(message: string, hint?: string, status?: number, exitCode?: number) {
    super(message);
    this.name = "CliError";
    this.hint = hint;
    this.status = status;
    this.exitCode = exitCode;
  }
}
