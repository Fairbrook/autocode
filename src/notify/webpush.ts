import webpush from "web-push";
import type { Db } from "../db/index.ts";
import { getAppSetting, setAppSetting, listActivePushSubscriptions, recordPushSuccess, recordPushFailure } from "../db/repo/push.ts";
import type { NotifyEvent } from "./index.ts";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Generated once on first boot and persisted — every subscription is bound to these keys for its lifetime. */
export function ensureVapidKeys(db: Db): VapidKeys {
  const existingPublic = getAppSetting(db, "vapid_public_key");
  const existingPrivate = getAppSetting(db, "vapid_private_key");
  if (existingPublic && existingPrivate) {
    return { publicKey: existingPublic, privateKey: existingPrivate };
  }
  const keys = webpush.generateVAPIDKeys();
  setAppSetting(db, "vapid_public_key", keys.publicKey);
  setAppSetting(db, "vapid_private_key", keys.privateKey);
  return keys;
}

export function configureWebPush(db: Db, contactEmail: string): VapidKeys {
  const keys = ensureVapidKeys(db);
  webpush.setVapidDetails(`mailto:${contactEmail}`, keys.publicKey, keys.privateKey);
  return keys;
}

/**
 * Sends to every active subscription, independently. A 404/410 means the
 * push service says the subscription is gone (browser data cleared,
 * uninstalled, etc.) — disable it so future sends don't keep retrying a
 * dead endpoint. Any other failure just increments a counter; it's not
 * assumed permanent.
 */
export async function sendWebPush(db: Db, event: NotifyEvent): Promise<void> {
  const subscriptions = listActivePushSubscriptions(db);
  const payload = JSON.stringify({ title: event.title, body: event.body, runId: event.runId, kind: event.kind });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          payload
        );
        recordPushSuccess(db, sub.endpoint);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const permanent = statusCode === 404 || statusCode === 410;
        recordPushFailure(db, sub.endpoint, permanent);
      }
    })
  );
}
