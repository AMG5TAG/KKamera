import webpush from "web-push";
import { db } from "@workspace/db";
import { pushSubscriptionsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "./logger.js";

let _configured = false;

function ensureConfigured() {
  if (_configured) return;
  const publicKey = process.env["VAPID_PUBLIC_KEY"];
  const privateKey = process.env["VAPID_PRIVATE_KEY"];
  const subject = process.env["VAPID_SUBJECT"] ?? "mailto:hello@kkamera.app";
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set");
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  _configured = true;
}

export type PushPayload =
  | { type: "trial_ending"; daysLeft: number }
  | { type: "trial_expired" }
  | { type: "upload_failed"; fileName: string }
  | { type: "upload_done"; fileName: string; destination: string }
  | { type: "payment_failed" }
  | { type: "subscription_renewed"; renewalDate: string }
  | { type: "custom"; title: string; body: string; url?: string };

function buildNotification(payload: PushPayload): { title: string; body: string; tag: string; url: string } {
  switch (payload.type) {
    case "trial_ending":
      return {
        title: "KKamera — Trial Ending Soon",
        body: `Your free trial ends in ${payload.daysLeft} day${payload.daysLeft === 1 ? "" : "s"}. Subscribe to keep your uploads flowing.`,
        tag: "trial-ending",
        url: "/settings/subscription",
      };
    case "trial_expired":
      return {
        title: "KKamera — Trial Expired",
        body: "Your free trial has ended. Subscribe now to restore camera access.",
        tag: "trial-expired",
        url: "/settings/subscription",
      };
    case "upload_failed":
      return {
        title: "Upload Failed",
        body: `${payload.fileName} could not be uploaded. Tap to retry.`,
        tag: `upload-failed-${payload.fileName}`,
        url: "/camera",
      };
    case "upload_done":
      return {
        title: "Upload Complete",
        body: `${payload.fileName} saved to ${payload.destination}.`,
        tag: `upload-done-${payload.fileName}`,
        url: "/camera",
      };
    case "payment_failed":
      return {
        title: "KKamera — Payment Failed",
        body: "We couldn't process your subscription payment. Please update your payment method.",
        tag: "payment-failed",
        url: "/settings/subscription",
      };
    case "subscription_renewed":
      return {
        title: "KKamera — Subscription Renewed",
        body: `Your subscription has been renewed. Next renewal: ${payload.renewalDate}.`,
        tag: "subscription-renewed",
        url: "/settings/subscription",
      };
    case "custom":
      return {
        title: payload.title,
        body: payload.body,
        tag: "custom",
        url: payload.url ?? "/",
      };
  }
}

/**
 * Send a push notification to all subscriptions for a given userId.
 * Silently removes any expired/invalid subscriptions from the DB.
 */
export async function sendPushToUser(userId: number, payload: PushPayload): Promise<void> {
  try {
    ensureConfigured();
  } catch (err) {
    logger.warn({ err }, "Push notifications not configured — skipping");
    return;
  }

  const subs = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId));

  if (subs.length === 0) return;

  const notification = buildNotification(payload);
  const notificationBody = JSON.stringify({
    title: notification.title,
    body: notification.body,
    tag: notification.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: notification.url, type: payload.type },
  });

  const expiredIds: number[] = [];

  await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          notificationBody
        );
      } catch (err: any) {
        // 404 or 410 = subscription expired/unsubscribed
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          expiredIds.push(sub.id);
        } else {
          logger.warn({ err, endpoint: sub.endpoint }, "Push send failed");
        }
      }
    })
  );

  if (expiredIds.length > 0) {
    await db.delete(pushSubscriptionsTable).where(inArray(pushSubscriptionsTable.id, expiredIds));
    logger.info({ count: expiredIds.length }, "Removed expired push subscriptions");
  }
}

/**
 * Send a push notification to all subscriptions for multiple userIds.
 */
export async function sendPushToUsers(userIds: number[], payload: PushPayload): Promise<void> {
  await Promise.allSettled(userIds.map((id) => sendPushToUser(id, payload)));
}
