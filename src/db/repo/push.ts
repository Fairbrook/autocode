import type { Db } from "../index.ts";
import { nowIso } from "../index.ts";
import type { PushSubscriptionRow } from "../../types.ts";

export function upsertPushSubscription(
  db: Db,
  input: { endpoint: string; p256dh: string; auth: string; userAgent?: string | null }
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at, disabled, failure_count)
     VALUES (?, ?, ?, ?, ?, 0, 0)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent,
       disabled = 0, failure_count = 0`
  ).run(input.endpoint, input.p256dh, input.auth, input.userAgent ?? null, nowIso());
}

export function listActivePushSubscriptions(db: Db): PushSubscriptionRow[] {
  return db
    .prepare("SELECT * FROM push_subscriptions WHERE disabled = 0")
    .all() as unknown as PushSubscriptionRow[];
}

export function recordPushSuccess(db: Db, endpoint: string): void {
  db.prepare(
    "UPDATE push_subscriptions SET last_success_at = ?, failure_count = 0 WHERE endpoint = ?"
  ).run(nowIso(), endpoint);
}

export function recordPushFailure(
  db: Db,
  endpoint: string,
  disable: boolean
): void {
  db.prepare(
    "UPDATE push_subscriptions SET failure_count = failure_count + 1, disabled = CASE WHEN ? THEN 1 ELSE disabled END WHERE endpoint = ?"
  ).run(disable ? 1 : 0, endpoint);
}

export function removePushSubscription(db: Db, endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function getAppSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setAppSetting(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
