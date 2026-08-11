import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { SessionRow } from "../../types.ts";

export function createSession(
  db: Db,
  input: {
    tokenHash: string;
    userId: number;
    expiresAt: string;
    userAgent?: string | null;
    ip?: string | null;
  }
): SessionRow {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.tokenHash,
      input.userId,
      now,
      input.expiresAt,
      now,
      input.userAgent ?? null,
      input.ip ?? null
    );
  const row = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(Number(result.lastInsertRowid)) as SessionRow | undefined;
  if (!row) throw new Error("failed to read back created session");
  return row;
}

/** Looks up a live (unexpired) session by token hash. Expired rows are treated as absent. */
export function getLiveSessionByTokenHash(db: Db, tokenHash: string): SessionRow | undefined {
  return db
    .prepare("SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .get(tokenHash, nowIso()) as SessionRow | undefined;
}

export function touchSession(db: Db, id: number): void {
  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(nowIso(), id);
}

/** Sliding expiry: an actively used session keeps moving its own deadline out. */
export function extendSession(db: Db, id: number, expiresAt: string): void {
  db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?").run(
    expiresAt,
    nowIso(),
    id
  );
}

export function deleteSessionByTokenHash(db: Db, tokenHash: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/** Used on password change and on account disable — every existing login for that user dies. */
export function deleteSessionsForUser(db: Db, userId: number): number {
  const result = db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  return Number(result.changes);
}

export function deleteExpiredSessions(db: Db): number {
  const result = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
  return Number(result.changes);
}

export function listSessionsForUser(db: Db, userId: number): SessionRow[] {
  return db
    .prepare("SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC")
    .all(userId) as unknown as SessionRow[];
}
