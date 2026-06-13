// CredentialStore — the on-disk session written by `boardwalk login`, read by every authenticated
// command.
//
// v0 storage: a single JSON file at `<configDir>/credentials.json`, dir mode 0700, file mode 0600
// (owner-only) — the same posture as the `gh` / `aws` CLIs. AES-at-rest + an OS keychain are a
// hardening follow-up; the interface here (get/put/clear a session) doesn't change when that lands.

import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** A cached inference-gateway key minted for `boardwalk dev` (one per api-host + org). Reused across
 *  dev runs until it nears expiry, then silently re-minted — so the author isn't littering the org
 *  with a fresh key on every run. It's a capped, inference-only credential (see the backend mint). */
export interface StoredInferenceKey {
  /** The plaintext `bwk_…` inference key. */
  token: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  /** The key row id, for diagnostics (not needed to use the key). */
  id: string | null;
}

interface CredentialsFile {
  session?: StoredSession;
  /** Cached inference keys, keyed by `<apiBaseUrl>|<orgSlug>`. */
  inferenceKeys?: Record<string, StoredInferenceKey>;
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
    // Read-modify-write so we don't drop the cached inference keys (or vice-versa).
    this.write({ ...this.read(), session });
  }

  /** The cached inference key for `<apiBaseUrl>|<orgSlug>`, or null if absent/malformed. */
  getInferenceKey(cacheKey: string): StoredInferenceKey | null {
    const key = this.read().inferenceKeys?.[cacheKey];
    return key !== undefined && isValidInferenceKey(key) ? key : null;
  }

  putInferenceKey(cacheKey: string, key: StoredInferenceKey): void {
    const file = this.read();
    this.write({
      ...file,
      inferenceKeys: { ...(file.inferenceKeys ?? {}), [cacheKey]: key },
    });
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
      if ("inferenceKeys" in parsed) {
        const keys = sanitizeInferenceKeys(parsed.inferenceKeys);
        if (keys !== undefined) file.inferenceKeys = keys;
      }
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
  if (typeof value !== "object" || value === null) return false;
  const s = value as Record<string, unknown>;
  return typeof s.accessToken === "string" && s.accessToken.length > 0;
}

function isValidInferenceKey(value: unknown): value is StoredInferenceKey {
  if (typeof value !== "object" || value === null) return false;
  const k = value as Record<string, unknown>;
  return (
    typeof k.token === "string" &&
    k.token.length > 0 &&
    typeof k.expiresAt === "number" &&
    (k.id === null || typeof k.id === "string")
  );
}

/** Keep only the well-formed entries from a parsed `inferenceKeys` map; undefined when none. */
function sanitizeInferenceKeys(value: unknown): Record<string, StoredInferenceKey> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: Record<string, StoredInferenceKey> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isValidInferenceKey(v)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
