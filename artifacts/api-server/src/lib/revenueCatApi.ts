import { db } from "@workspace/db";
import { subscriptionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import {
  allowSandboxIap,
  mapSubscriberEntitlement,
  mergeDecision,
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

export type MirrorResult = "written" | "no_user" | "no_op";

/**
 * Apply a mirror decision to a user's subscriptions row. Runs under a row lock so
 * concurrent webhooks/syncs serialise, and refuses users that no longer exist
 * (e.g. deleted accounts whose store subscription is still running) so we never
 * create orphan rows.
 */
export async function applyMirrorDecision(userId: number, d: MirrorDecision): Promise<MirrorResult> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!user) return "no_user";

    const [row] = await tx
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .for("update")
      .limit(1);

    const next = mergeDecision(row ?? null, d, new Date());
    if (!next) return "no_op";

    if (row) {
      await tx.update(subscriptionsTable).set(next).where(eq(subscriptionsTable.userId, userId));
    } else {
      // Concurrent first insert for the same user is harmless: the loser's
      // conflict is a no-op and the next event/sync converges the row.
      await tx.insert(subscriptionsTable).values({ userId, ...next }).onConflictDoNothing();
    }
    return "written";
  });
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

  if (mapped.kind === "entitled") {
    const result = await applyMirrorDecision(userId, mapped.decision);
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
    const result = await applyMirrorDecision(userId, { kind: "refund", userId, periodEnd: new Date(), referrals: false });
    logger.info({ userId, result }, "RevenueCat transfer source revoked");
    return result;
  }

  logger.info({ userId, reason: mapped.reason }, "RevenueCat sync: no active entitlement (no change)");
  return "no_op";
}
