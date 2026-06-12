// CredentialStore — the on-disk session written by `boardwalk login`, read by every authenticated
// command.
//
// v0 storage: a single JSON file at `<configDir>/credentials.json`, dir mode 0700, file mode 0600
// (owner-only) — the same posture as the `gh` / `aws` CLIs. AES-at-rest + an OS keychain are a
// hardening follow-up; the interface here (get/put/clear a session) doesn't change when that lands.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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
    this.write({ session });
  }

  /** Remove any stored session (logout). Idempotent — a missing file is fine. */
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
      if (typeof parsed === "object" && parsed !== null && "session" in parsed) {
        const session: unknown = parsed.session;
        if (isValidSession(session)) return { session };
      }
    } catch {
      // Malformed file → treat as no credentials rather than crashing the command.
    }
    return {};
  }

  private write(file: CredentialsFile): void {
    mkdirSync(dirOf(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  }
}

function dirOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "." : filePath.slice(0, idx);
}

function isValidSession(value: unknown): value is StoredSession {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.accessToken === "string" && s.accessToken.length > 0;
}
