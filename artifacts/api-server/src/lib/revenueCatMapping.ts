// Pure decision logic for the RevenueCat webhook mirror and REST reconciliation —
// no DB imports, so it's unit-testable in isolation (see
// test/revenueCatMapping.test.ts). lib/revenueCatApi.ts turns a decision into the
// actual DB write.

import crypto from "node:crypto";

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

// CANCELLATION cancel_reason RevenueCat uses for a refund (Apple support refund,
// Play refund via RevenueCat, etc.) — per RevenueCat's webhook event-field docs.
const REFUND_CANCEL_REASON = "CUSTOMER_SUPPORT";

/**
 * Whether sandbox (TestFlight / Play test track) purchases may grant access.
 * Off by default so a sandbox receipt can never unlock production uploads;
 * enable with ALLOW_SANDBOX_IAP=true for staging/testing. Sandbox events never
 * complete or reverse referrals regardless.
 */
export function allowSandboxIap(): boolean {
  return process.env["ALLOW_SANDBOX_IAP"] === "true";
}

/**
 * Constant-time compare for the webhook shared secret. Comparing fixed-length
 * SHA-256 digests means neither a length check nor timingSafeEqual leaks the
 * secret's length.
 */
export function secretsEqual(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export interface RCEvent {
  /** Unique event id; RevenueCat retries reuse the same id. */
  id?: unknown;
  type?: unknown;
  /** When RevenueCat generated the event (ms). Retries reuse it too. */
  event_timestamp_ms?: unknown;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  aliases?: unknown;
  entitlement_ids?: unknown;
  entitlement_id?: unknown;
  expiration_at_ms?: unknown;
  environment?: unknown;
  cancel_reason?: unknown;
  transferred_from?: unknown;
  transferred_to?: unknown;
}

export interface MapOptions {
  /** Result of allowSandboxIap() — injected so the mapping stays pure. */
  allowSandbox: boolean;
}

// `referrals` is false for sandbox events: they may touch access (when allowed)
// but must never complete or reverse a referral. `eventAt` is the webhook's
// event_timestamp_ms (absent for REST snapshots and events that don't carry it)
// and drives out-of-order protection in mergeDecision.
export type RCDecision =
  | { kind: "ignore"; reason: string; userId?: number }
  | { kind: "grant"; userId: number; periodEnd: Date; referrals: boolean; eventAt?: Date | null }
  | { kind: "cancel"; userId: number; periodEnd: Date | null; referrals: boolean; eventAt?: Date | null }
  | { kind: "refund"; userId: number; periodEnd: Date; referrals: boolean; eventAt?: Date | null }
  | { kind: "past_due"; userId: number; periodEnd: Date | null; referrals: boolean; eventAt?: Date | null }
  | { kind: "expire"; userId: number; referrals: boolean; eventAt?: Date | null }
  | { kind: "transfer"; fromUserIds: number[]; toUserIds: number[] };

/**
 * The event's idempotency key (`id`), or null when missing/malformed. Bounded
 * so a hostile payload can't bloat the revenuecat_events table.
 */
export function eventIdOf(ev: RCEvent): string | null {
  const id = ev?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 200 ? id : null;
}

/** When RevenueCat generated the event (`event_timestamp_ms`), or null. */
export function eventTimeOf(ev: RCEvent): Date | null {
  const ms = Number(ev?.event_timestamp_ms);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/** A valid positive-integer user id, or null (anonymous / malformed). */
function toUserId(c: unknown): number | null {
  const n = Number(c);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve our numeric userId from the RC app_user_id / original / aliases. */
export function resolveUserId(ev: RCEvent): number | null {
  const aliases = Array.isArray(ev?.aliases) ? ev.aliases : [];
  const candidates = [ev?.app_user_id, ev?.original_app_user_id, ...aliases];
  for (const c of candidates) {
    const n = toUserId(c);
    if (n) return n;
  }
  return null;
}

/** Unique numeric user ids from a TRANSFER id list (anonymous ids dropped). */
export function numericUserIds(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  const ids = list.map(toUserId).filter((n): n is number => n !== null);
  return [...new Set(ids)];
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
export function mapRevenueCatEvent(ev: RCEvent, nowMs: number, opts: MapOptions): RCDecision {
  if (!ev || typeof ev.type !== "string") return { kind: "ignore", reason: "no event type" };

  // Missing `environment` is treated as production (RevenueCat always sends it).
  const sandbox = ev.environment === "SANDBOX";
  if (sandbox && !opts.allowSandbox) return { kind: "ignore", reason: "sandbox event (ALLOW_SANDBOX_IAP off)" };
  const referrals = !sandbox;

  // TRANSFER carries no app_user_id — only the from/to id lists. The route
  // re-syncs each affected user from the REST API rather than guessing.
  if (ev.type === "TRANSFER") {
    const fromUserIds = numericUserIds(ev.transferred_from);
    const toUserIds = numericUserIds(ev.transferred_to);
    if (fromUserIds.length === 0 && toUserIds.length === 0) {
      return { kind: "ignore", reason: "transfer between anonymous ids" };
    }
    return { kind: "transfer", fromUserIds, toUserIds };
  }

  const userId = resolveUserId(ev);
  if (!userId) return { kind: "ignore", reason: "no numeric app_user_id" };
  if (!touchesProEntitlement(ev)) return { kind: "ignore", reason: "not the pro entitlement", userId };

  const expMs = Number(ev.expiration_at_ms);
  const periodEnd = Number.isFinite(expMs) && expMs > 0 ? new Date(expMs) : null;
  const eventAt = eventTimeOf(ev);

  if (GRANTING.has(ev.type)) {
    if (!periodEnd) return { kind: "ignore", reason: "grant without expiration", userId };
    return { kind: "grant", userId, periodEnd, referrals, eventAt };
  }
  if (ev.type === "CANCELLATION") {
    // A refund ends access at the refund's expiration (which RevenueCat may send
    // as null/negative — then it ends now), never later.
    if (ev.cancel_reason === REFUND_CANCEL_REASON) {
      return { kind: "refund", userId, periodEnd: periodEnd ?? new Date(nowMs), referrals, eventAt };
    }
    return { kind: "cancel", userId, periodEnd, referrals, eventAt };
  }
  if (ev.type === "BILLING_ISSUE") return { kind: "past_due", userId, periodEnd, referrals, eventAt };
  if (ev.type === "EXPIRATION") {
    // Only expire if the entitlement has actually lapsed by now.
    if (!periodEnd || periodEnd.getTime() <= nowMs) return { kind: "expire", userId, referrals, eventAt };
    return { kind: "ignore", reason: "future-dated expiration (stale)", userId };
  }
  return { kind: "ignore", reason: "no state change for event type", userId };
}

// ---------------------------------------------------------------------------
// Row merge — how a decision changes an existing subscriptions row.
// ---------------------------------------------------------------------------

export interface MirrorRow {
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
  /** Newest applied event time (subscriptions.last_event_at); null = none yet. */
  lastEventAt?: Date | null;
}

export interface MergeOptions {
  /**
   * The decision comes from a REST snapshot (/subscriptions/sync, TRANSFER
   * re-sync), not a webhook event: it describes the store state as of now, so
   * it is never treated as stale and stamps lastEventAt with `now`.
   */
  snapshot?: boolean;
}

export interface MirrorWrite {
  status: string;
  currentPeriodEnd: Date | null;
  lastEventAt: Date | null;
}

export type MirrorDecision = Extract<RCDecision, { kind: "grant" | "cancel" | "refund" | "past_due" | "expire" }>;

function maxDate(...ds: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of ds) if (d && (!best || d > best)) best = d;
  return best;
}

/**
 * The access end a row already carries: its period end, plus a still-running
 * server trial (a row in `trial` only has trialEnd). Folding the trial in means a
 * short store-side trial / early purchase never shortens the 24-hour server trial.
 */
function existingAccessEnd(row: MirrorRow): Date | null {
  return maxDate(row.currentPeriodEnd, row.status === "trial" ? row.trialEnd : null);
}

/**
 * The event time used for ordering: event_timestamp_ms clamped to `now`, so a
 * bogus future timestamp (or clock skew) can never pin lastEventAt ahead of
 * real time and block every later event.
 */
function effectiveEventAt(d: MirrorDecision, now: Date): Date | null {
  const at = d.eventAt ?? null;
  if (!at) return null;
  return at > now ? now : at;
}

/**
 * True when `d` is a webhook event OLDER than the newest event already applied
 * to the row — i.e. delivered out of order (RevenueCat does not guarantee
 * ordering). Equal timestamps are not stale; events without a timestamp and
 * REST snapshots are never stale. Refunds are never stale: money went back, so
 * the revocation always applies whatever else happened since.
 */
export function isStaleDecision(row: MirrorRow | null, d: MirrorDecision, now: Date, opts: MergeOptions = {}): boolean {
  if (opts.snapshot || d.kind === "refund") return false;
  const at = effectiveEventAt(d, now);
  const last = row?.lastEventAt ?? null;
  return !!(at && last && at < last);
}

/**
 * Compute the new {status, currentPeriodEnd, lastEventAt} for a decision against
 * the current row (null = no row yet). Returns null when the decision must not
 * write. Period ends are forward-only (so out-of-order delivery and referral free
 * years are never shortened) — except a refund, which pins the end to the refund.
 *
 * Ordering: a stale event (see isStaleDecision) never changes status — an old
 * CANCELLATION / BILLING_ISSUE / EXPIRATION can't downgrade state set by a newer
 * RENEWAL/UNCANCELLATION, and an old grant can't resurrect a newer cancel/expiry.
 * The only thing a stale event may still do is extend the period end of a live
 * paid row (active / past_due) — forward-only, so it can't cost the user access,
 * and it never touches a cancelled/expired/trial row (which may be a refund's
 * pinned end). Non-stale writes advance lastEventAt (never backwards, never
 * beyond `now`); snapshots stamp it with `now`.
 */
export function mergeDecision(
  row: MirrorRow | null,
  d: MirrorDecision,
  now: Date,
  opts: MergeOptions = {},
): MirrorWrite | null {
  const lastEventAt = maxDate(row?.lastEventAt, opts.snapshot ? now : effectiveEventAt(d, now));

  if (row && isStaleDecision(row, d, now, opts)) {
    if (d.kind === "expire") return null;
    if (row.status !== "active" && row.status !== "past_due") return null;
    const end = maxDate(row.currentPeriodEnd, d.periodEnd);
    if (!end || (row.currentPeriodEnd && end.getTime() === row.currentPeriodEnd.getTime())) return null;
    return { status: row.status, currentPeriodEnd: end, lastEventAt: row.lastEventAt ?? null };
  }

  const prevEnd = row ? existingAccessEnd(row) : null;
  switch (d.kind) {
    case "grant":
      return { status: "active", currentPeriodEnd: maxDate(prevEnd, d.periodEnd), lastEventAt };
    case "cancel":
      // Auto-renew off; access continues until the (forward-only) period end.
      return { status: "cancelled", currentPeriodEnd: maxDate(prevEnd, d.periodEnd), lastEventAt };
    case "past_due":
      if (!row) return null; // nothing to mark past due
      return { status: "past_due", currentPeriodEnd: maxDate(prevEnd, d.periodEnd), lastEventAt };
    case "expire": {
      if (!row) return null;
      // The store entitlement lapsed, but the row may still carry access past it
      // (a referral free year extended currentPeriodEnd, or the server trial is
      // still running). Keep that access instead of wiping it.
      if (row.status === "trial" && row.trialEnd && row.trialEnd > now) {
        return { status: "trial", currentPeriodEnd: row.currentPeriodEnd, lastEventAt };
      }
      if (prevEnd && prevEnd > now) return { status: "cancelled", currentPeriodEnd: prevEnd, lastEventAt };
      return { status: "expired", currentPeriodEnd: row.currentPeriodEnd, lastEventAt };
    }
    case "refund": {
      if (!row) return null; // nothing was granted, nothing to take back
      // Not forward-only: the refunded period is revoked. An unused server trial
      // (trialEnd is kept on the row) is restored rather than burned.
      if (d.periodEnd > now) return { status: "cancelled", currentPeriodEnd: d.periodEnd, lastEventAt };
      if (row.trialEnd && row.trialEnd > now) return { status: "trial", currentPeriodEnd: d.periodEnd, lastEventAt };
      return { status: "expired", currentPeriodEnd: d.periodEnd, lastEventAt };
    }
  }
}

// ---------------------------------------------------------------------------
// REST reconciliation — GET /v1/subscribers/{app_user_id}
// ---------------------------------------------------------------------------

export type SubscriberDecision =
  | { kind: "none"; reason: string }
  | {
      kind: "entitled";
      decision: Extract<MirrorDecision, { kind: "grant" | "cancel" | "past_due" }>;
      store: string | null;
      periodType: string | null;
      sandbox: boolean;
    };

function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map a RevenueCat v1 subscriber payload to the mirror write for the `pro`
 * entitlement. Only an entitlement active at `now` yields a write; the sync is
 * upgrade-only (expiry/refund arrive via webhook), so "none" means leave the row.
 * Never completes referrals (no price information) — that stays webhook-driven.
 */
export function mapSubscriberEntitlement(
  body: unknown,
  userId: number,
  now: Date,
  opts: MapOptions,
): SubscriberDecision {
  const subscriber = (body as any)?.subscriber;
  if (!subscriber || typeof subscriber !== "object") return { kind: "none", reason: "no subscriber" };

  const ent = subscriber.entitlements?.[ENTITLEMENT];
  if (!ent) return { kind: "none", reason: "no pro entitlement" };

  const productId = typeof ent.product_identifier === "string" ? ent.product_identifier : null;
  const sub = productId ? subscriber.subscriptions?.[productId] ?? null : null;
  const sandbox = sub?.is_sandbox === true;
  if (sandbox && !opts.allowSandbox) return { kind: "none", reason: "sandbox entitlement (ALLOW_SANDBOX_IAP off)" };

  // A null expires_date is a lifetime/non-expiring grant — never mirrored as
  // perpetual access (same rule as the webhook).
  const expires = parseDate(ent.expires_date);
  if (!expires) return { kind: "none", reason: "entitlement without expiration" };
  const accessEnd = maxDate(expires, parseDate(ent.grace_period_expires_date))!;
  if (accessEnd <= now) return { kind: "none", reason: "entitlement expired" };
  if (sub && parseDate(sub.refunded_at)) return { kind: "none", reason: "refunded" };

  const base = { store: typeof sub?.store === "string" ? sub.store : null, periodType: typeof sub?.period_type === "string" ? sub.period_type : null, sandbox };
  if (expires <= now) {
    // Only the billing grace period is keeping it alive.
    return { kind: "entitled", decision: { kind: "past_due", userId, periodEnd: expires, referrals: false }, ...base };
  }
  if (sub && parseDate(sub.billing_issues_detected_at)) {
    return { kind: "entitled", decision: { kind: "past_due", userId, periodEnd: expires, referrals: false }, ...base };
  }
  if (sub && parseDate(sub.unsubscribe_detected_at)) {
    return { kind: "entitled", decision: { kind: "cancel", userId, periodEnd: expires, referrals: false }, ...base };
  }
  return { kind: "entitled", decision: { kind: "grant", userId, periodEnd: expires, referrals: false }, ...base };
}
