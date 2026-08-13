// Pure decision logic for the RevenueCat webhook mirror — no DB imports, so it's
// unit-testable in isolation (see test/revenueCatMapping.test.ts). The route
// (routes/revenuecat.ts) turns a decision into the actual DB write.

const ENTITLEMENT = "pro"; // mirrors REVENUECAT_ENTITLEMENT_IDENTIFIER on the client

// RevenueCat event types that grant or extend access.
const GRANTING = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "PRODUCT_CHANGE",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
]);

export interface RCEvent {
  type?: unknown;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  aliases?: unknown;
  entitlement_ids?: unknown;
  entitlement_id?: unknown;
  expiration_at_ms?: unknown;
}

export type RCDecision =
  | { kind: "ignore"; reason: string }
  | { kind: "grant"; userId: number; periodEnd: Date }
  | { kind: "cancel"; userId: number; periodEnd: Date | null }
  | { kind: "past_due"; userId: number; periodEnd: Date | null }
  | { kind: "expire"; userId: number };

/** Resolve our numeric userId from the RC app_user_id / original / aliases. */
export function resolveUserId(ev: RCEvent): number | null {
  const aliases = Array.isArray(ev?.aliases) ? ev.aliases : [];
  const candidates = [ev?.app_user_id, ev?.original_app_user_id, ...aliases];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** True when this event concerns the "pro" entitlement (or doesn't scope one). */
export function touchesProEntitlement(ev: RCEvent): boolean {
  const ids: unknown = Array.isArray(ev?.entitlement_ids)
    ? ev.entitlement_ids
    : ev?.entitlement_id
      ? [ev.entitlement_id]
      : null;
  if (!Array.isArray(ids)) return true; // unscoped event — process it
  return ids.includes(ENTITLEMENT);
}

/**
 * Decide how a RevenueCat webhook event should update our subscription mirror.
 * `nowMs` is passed in (not read from the clock) so the decision is deterministic
 * and testable. Grants require a valid future/known expiration; a future-dated
 * EXPIRATION is treated as stale relative to a later renewal and ignored.
 */
export function mapRevenueCatEvent(ev: RCEvent, nowMs: number): RCDecision {
  if (!ev || typeof ev.type !== "string") return { kind: "ignore", reason: "no event type" };

  const userId = resolveUserId(ev);
  if (!userId) return { kind: "ignore", reason: "no numeric app_user_id" };
  if (!touchesProEntitlement(ev)) return { kind: "ignore", reason: "not the pro entitlement" };

  const expMs = Number(ev.expiration_at_ms);
  const periodEnd = Number.isFinite(expMs) && expMs > 0 ? new Date(expMs) : null;

  if (GRANTING.has(ev.type)) {
    if (!periodEnd) return { kind: "ignore", reason: "grant without expiration" };
    return { kind: "grant", userId, periodEnd };
  }
  if (ev.type === "CANCELLATION") return { kind: "cancel", userId, periodEnd };
  if (ev.type === "BILLING_ISSUE") return { kind: "past_due", userId, periodEnd };
  if (ev.type === "EXPIRATION") {
    // Only expire if the entitlement has actually lapsed by now.
    if (!periodEnd || periodEnd.getTime() <= nowMs) return { kind: "expire", userId };
    return { kind: "ignore", reason: "future-dated expiration (stale)" };
  }
  return { kind: "ignore", reason: "no state change for event type" };
}
