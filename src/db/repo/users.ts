import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { UserRow } from "../../types.ts";

/** Usernames are stored and compared lowercased — "Kevin" and "kevin" are the same account. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function createUser(
  db: Db,
  input: { username: string; passwordHash: string }
): UserRow {
  const now = nowIso();
  const result = db
    .prepare(
      `INSERT INTO users (username, password_hash, disabled, created_at, password_changed_at)
       VALUES (?, ?, 0, ?, ?)`
    )
    .run(normalizeUsername(input.username), input.passwordHash, now, now);
  const row = getUserById(db, Number(result.lastInsertRowid));
  if (!row) throw new Error("failed to read back created user");
  return row;
}

export function getUserById(db: Db, id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function getUserByUsername(db: Db, username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(normalizeUsername(username)) as
    | UserRow
    | undefined;
}

export function listUsers(db: Db): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY username").all() as unknown as UserRow[];
}

export function countUsers(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) as n FROM users").get() as { n: number };
  return row.n;
}

/** Callers must revoke the user's sessions afterwards — a changed password should not leave old logins alive. */
export function setUserPassword(db: Db, id: number, passwordHash: string): void {
  db.prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?").run(
    passwordHash,
    nowIso(),
    id
  );
}

export function setUserDisabled(db: Db, id: number, disabled: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
}

export function markUserLogin(db: Db, id: number): void {
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), id);
}
