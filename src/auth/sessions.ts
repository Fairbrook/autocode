import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/index.ts";
import {
  createSession,
  extendSession,
  getLiveSessionByTokenHash,
  touchSession,
} from "../db/repo/sessions.ts";
import { getUserById } from "../db/repo/users.ts";
import type { SessionRow, UserRow } from "../types.ts";

/** 256 bits of CSPRNG output — the entire security of a logged-in session rests on this value. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface StartedSession {
  token: string;
  session: SessionRow;
}

export function startSession(
  db: Db,
  input: { userId: number; ttlMs: number; userAgent?: string | null; ip?: string | null }
): StartedSession {
  const token = generateSessionToken();
  const session = createSession(db, {
    tokenHash: hashSessionToken(token),
    userId: input.userId,
    expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
    userAgent: input.userAgent ?? null,
    ip: input.ip ?? null,
  });
  return { token, session };
}

export interface ResolvedSession {
  session: SessionRow;
  user: UserRow;
}

/**
 * Resolves a cookie value to a live session + enabled user, sliding the
 * expiry forward as it goes.
 *
 * The user row is re-read on every request rather than trusted from the
 * session, so disabling an account takes effect immediately instead of at
 * the end of a 30-day cookie's life.
 */
export function resolveSession(
  db: Db,
  token: string | undefined,
  ttlMs: number
): ResolvedSession | null {
  if (!token) return null;
  const session = getLiveSessionByTokenHash(db, hashSessionToken(token));
  if (!session) return null;

  const user = getUserById(db, session.user_id);
  if (!user || user.disabled) return null;

  // Sliding window, written only when it actually moves the deadline by a
  // meaningful amount. Every static asset on every page load comes through
  // here, so the common case must not be a DB write.
  const remaining = new Date(session.expires_at).getTime() - Date.now();
  const lastSeenAgeMs = Date.now() - new Date(session.last_seen_at).getTime();
  if (remaining < ttlMs * 0.9) {
    extendSession(db, session.id, new Date(Date.now() + ttlMs).toISOString());
  } else if (lastSeenAgeMs > 60_000) {
    touchSession(db, session.id);
  }

  return { session, user };
}
