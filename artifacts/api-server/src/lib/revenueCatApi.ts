import { db } from "@workspace/db";
import { revenueCatEventsTable, subscriptionsTable, usersTable } from "@workspace/db";
import { eq, lt } from "drizzle-orm";
import { logger } from "./logger.js";
import type { DbTx } from "./referrals.js";
import {
  allowSandboxIap,
  isStaleDecision,
  mapSubscriberEntitlement,
  mergeDecision,
  type MergeOptions,
  type MirrorDecision,
} from "./revenueCatMapping.js";

/**
 * RevenueCat REST reconciliation + the shared subscriptions-mirror writer used by
 * both the webhook (routes/revenuecat.ts) and POST /subscriptions/sync.
 */

const RC_API = "https://api.revenuecat.com/v1";

export class RevenueCatNotConfiguredError extends Error {
  constructor() {
    super("RevenueCat sync is not configured");
  }
}

/** GET /v1/subscribers/{app_user_id} with the secret API key. */
export async function fetchSubscriber(appUserId: string): Promise<unknown> {
  const key = process.env["REVENUECAT_SECRET_API_KEY"];
  if (!key) throw new RevenueCatNotConfiguredError();
  const res = await fetch(`${RC_API}/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`RevenueCat subscriber fetch failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * "stale": the event is older than the newest one already applied (out-of-order
 * delivery) — status was left alone; at most a live period end was extended.
 */
export type MirrorResult = "written" | "no_user" | "no_op" | "stale";

/**
 * Apply a mirror decision to a user's subscriptions row inside `tx`. Takes a row
 * lock so concurrent webhooks/syncs serialise, and refuses users that no longer
 * exist (e.g. deleted accounts whose store subscription is still running) so we
 * never create orphan rows.
 */
export async function applyMirrorDecisionInTx(
  tx: DbTx,
  userId: number,
  d: MirrorDecision,
  opts: MergeOptions = {},
): Promise<MirrorResult> {
  const [user] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return "no_user";

  const [row] = await tx
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .for("update")
    .limit(1);

  const now = new Date();
  const stale = isStaleDecision(row ?? null, d, now, opts);
  const next = mergeDecision(row ?? null, d, now, opts);
  if (!next) return stale ? "stale" : "no_op";

  if (row) {
    await tx.update(subscriptionsTable).set(next).where(eq(subscriptionsTable.userId, userId));
  } else {
    // Concurrent first insert for the same user is harmless: the loser's
    // conflict is a no-op and the next event/sync converges the row.
    await tx.insert(subscriptionsTable).values({ userId, ...next }).onConflictDoNothing();
  }
  return stale ? "stale" : "written";
}

/** applyMirrorDecisionInTx in its own transaction. */
export async function applyMirrorDecision(userId: number, d: MirrorDecision, opts: MergeOptions = {}): Promise<MirrorResult> {
  return db.transaction((tx) => applyMirrorDecisionInTx(tx, userId, d, opts));
}

// ---------------------------------------------------------------------------
// Webhook idempotency — revenuecat_events
// ---------------------------------------------------------------------------

/**
 * Record a webhook event id inside `tx`. Returns false if it was already
 * recorded (a RevenueCat retry/redelivery). A concurrent delivery of the same
 * id blocks on the primary key until the first transaction finishes, then sees
 * the conflict — so an event is applied at most once, and if the applying
 * transaction rolls back the id is released for RevenueCat's retry.
 */
export async function claimRevenueCatEvent(
  tx: DbTx | typeof db,
  eventId: string,
  userId: number | null,
  type: string,
): Promise<boolean> {
  const inserted = await tx
    .insert(revenueCatEventsTable)
    .values({ eventId, userId, type: type.slice(0, 64) })
    .onConflictDoNothing()
    .returning({ eventId: revenueCatEventsTable.eventId });
  return inserted.length > 0;
}

/** True when an event id was already processed (used before non-transactional work). */
export async function isRevenueCatEventRecorded(eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ eventId: revenueCatEventsTable.eventId })
    .from(revenueCatEventsTable)
    .where(eq(revenueCatEventsTable.eventId, eventId))
    .limit(1);
  return !!row;
}

export const REVENUECAT_EVENT_RETENTION_DAYS = 90;

/** Delete processed-event ids older than the retention window. Returns rows deleted. */
export async function pruneRevenueCatEvents(): Promise<number> {
  const cutoff = new Date(Date.now() - REVENUECAT_EVENT_RETENTION_DAYS * 86_400_000);
  const res = await db.delete(revenueCatEventsTable).where(lt(revenueCatEventsTable.receivedAt, cutoff));
  return res.rowCount ?? 0;
}

export interface SyncOptions {
  /**
   * Treat "no active entitlement" as authoritative and revoke mirrored store
   * access. Only for TRANSFER sources (the purchase moved to another user);
   * a normal sync is upgrade-only because expiry/refund arrive via webhook and
   * a mis-aliased lookup must never strip a paying user.
   */
  revokeIfNone?: boolean;
}

/**
 * Re-read a user's `pro` entitlement from RevenueCat and upsert the mirror.
 * Throws RevenueCatNotConfiguredError if REVENUECAT_SECRET_API_KEY is unset.
 */
export async function syncUserFromRevenueCat(userId: number, opts: SyncOptions = {}): Promise<MirrorResult> {
  const body = await fetchSubscriber(String(userId));
  const mapped = mapSubscriberEntitlement(body, userId, new Date(), { allowSandbox: allowSandboxIap() });

  // REST reads are snapshots of current store state: never blocked by (and they
  // stamp) subscriptions.last_event_at, so older in-flight webhooks can't undo them.
  if (mapped.kind === "entitled") {
    const result = await applyMirrorDecision(userId, mapped.decision, { snapshot: true });
    logger.info(
      { userId, result, status: mapped.decision.kind, store: mapped.store, periodType: mapped.periodType, sandbox: mapped.sandbox },
      "RevenueCat sync applied",
    );
    return result;
  }

  if (opts.revokeIfNone) {
    const [row] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, userId)).limit(1);
    if (!row || !["active", "cancelled", "past_due"].includes(row.status)) return "no_op";
    // A referral free year also lives in currentPeriodEnd and can't be told apart
    // from store time — don't revoke those; leave them for manual review.
    if (row.freeYearsAwarded > 0) {
      logger.warn({ userId }, "RevenueCat transfer source has referral free years — not revoking");
      return "no_op";
    }
    const result = await applyMirrorDecision(userId, { kind: "refund", userId, periodEnd: new Date(), referrals: false }, { snapshot: true });
    logger.info({ userId, result }, "RevenueCat transfer source revoked");
    return result;
  }

  logger.info({ userId, reason: mapped.reason }, "RevenueCat sync: no active entitlement (no change)");
  return "no_op";
}
