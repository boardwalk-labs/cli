// SPDX-License-Identifier: MIT

// CredentialStore — the on-disk session written by `boardwalk login`, read by every authenticated
// command.
//
// v0 storage: a single JSON file at `<configDir>/credentials.json`, dir mode 0700, file mode 0600
// (owner-only) — the same posture as the `gh` / `aws` CLIs. AES-at-rest + an OS keychain are a
// hardening follow-up; the interface here (get/put/clear a session) doesn't change when that lands.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./guards.js";

/** A logged-in user's OAuth session. `null` fields = the IdP omitted them (e.g. no refresh token). */
export interface StoredSession {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute access-token expiry, epoch ms; null = unknown (treated as non-expiring). */
  expiresAt: number | null;
  /** The OAuth client id used — needed to refresh. */
  clientId: string | null;
  /** The token endpoint to refresh against. */
  tokenEndpoint: string | null;
  scope: string | null;
}

interface CredentialsFile {
  session?: StoredSession;
}

export class CredentialStore {
  constructor(private readonly filePath: string) {}

  static atConfigDir(configDir: string): CredentialStore {
    return new CredentialStore(join(configDir, "credentials.json"));
  }

  getSession(): StoredSession | null {
    const session = this.read().session;
    return session !== undefined && isValidSession(session) ? session : null;
  }

  putSession(session: StoredSession): void {
    this.write({ ...this.read(), session });
  }

  /** Remove any stored credentials (logout). Idempotent — a missing file is fine. */
  clear(): void {
    try {
      rmSync(this.filePath, { force: true });
    } catch {
      // Best-effort: a missing/locked file shouldn't make logout fail.
    }
  }

  private read(): CredentialsFile {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      return {}; // missing/unreadable → no credentials
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      const file: CredentialsFile = {};
      if ("session" in parsed && isValidSession(parsed.session)) file.session = parsed.session;
      return file;
    } catch {
      // Malformed file → treat as no credentials rather than crashing the command.
      return {};
    }
  }

  private write(file: CredentialsFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

function isValidSession(value: unknown): value is StoredSession {
  if (!isRecord(value)) return false;
  // Validate EVERY field the predicate asserts — not just `accessToken`. A tampered file with, say,
  // a string `expiresAt` must fail here (→ treated as no session) rather than flow a wrong-typed
  // value into `isExpired`'s arithmetic. The nullable fields accept `string | null` per StoredSession.
  return (
    typeof value.accessToken === "string" &&
    value.accessToken.length > 0 &&
    (value.refreshToken === null || typeof value.refreshToken === "string") &&
    (value.expiresAt === null || typeof value.expiresAt === "number") &&
    (value.clientId === null || typeof value.clientId === "string") &&
    (value.tokenEndpoint === null || typeof value.tokenEndpoint === "string") &&
    (value.scope === null || typeof value.scope === "string")
  );
}
