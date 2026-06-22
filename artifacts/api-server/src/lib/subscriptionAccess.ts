// Pure subscription-gating decision logic — no imports, so it's unit-testable
// (see test/subscriptionAccess.test.ts). requireSubscription wraps it.

// Mirrors SUBSCRIPTION_STATUS in ./constants.ts. Kept inline so this stays a
// dependency-free module; these are DB-persisted status strings and are stable.
const SUBSCRIPTION_STATUS = {
  TRIAL: "trial",
  ACTIVE: "active",
  CANCELLED: "cancelled",
  PAST_DUE: "past_due",
} as const;

export interface AccessInput {
  status: string;
  trialEnd: Date | null;
  currentPeriodEnd: Date | null;
}

export interface AccessDecision {
  allow: boolean;
  message?: string;
}

/**
 * Grace period (ms) for which a `past_due` subscription keeps access past its
 * last paid period end before being blocked. Default 14 days; override with
 * the PAST_DUE_GRACE_DAYS env var.
 */
export function pastDueGraceMs(): number {
  const days = Number(process.env["PAST_DUE_GRACE_DAYS"]);
  return (Number.isFinite(days) && days >= 0 ? days : 14) * 86_400_000;
}

/** Decide whether a subscription row grants upload access at time `now`. */
export function evaluateAccess(
  sub: AccessInput | null | undefined,
  now: Date,
  graceMs: number = pastDueGraceMs(),
): AccessDecision {
  if (!sub) {
    return { allow: false, message: "No active subscription. Start a trial or subscribe to upload." };
  }

  switch (sub.status) {
    case SUBSCRIPTION_STATUS.TRIAL:
      // A trial with no end date is untrusted — deny rather than grant unlimited
      // free access (e.g. a row left in "trial" by a webhook without a trialEnd).
      if (!sub.trialEnd || sub.trialEnd < now) {
        return { allow: false, message: "Your trial has expired. Subscribe to continue uploading." };
      }
      return { allow: true };

    case SUBSCRIPTION_STATUS.ACTIVE:
      // An active row with no period end is untrusted (e.g. an activation that
      // raced the Stripe fetch) — deny rather than grant perpetual free access.
      if (!sub.currentPeriodEnd || sub.currentPeriodEnd < now) {
        return { allow: false, message: "Your subscription has expired. Renew to continue uploading." };
      }
      return { allow: true };

    case SUBSCRIPTION_STATUS.CANCELLED: {
      // Auto-renew off: keep access until the already-paid period/trial elapses.
      const accessUntil = sub.currentPeriodEnd ?? sub.trialEnd;
      if (accessUntil && accessUntil > now) return { allow: true };
      return { allow: false, message: "Your subscription has ended. Resubscribe to continue uploading." };
    }

    case SUBSCRIPTION_STATUS.PAST_DUE:
      // Allow while Stripe retries collection, but bound it: a permanently-failing
      // payment loses access a grace period after the last paid period end.
      if (sub.currentPeriodEnd && now.getTime() <= sub.currentPeriodEnd.getTime() + graceMs) {
        return { allow: true };
      }
      return { allow: false, message: "Your payment is overdue. Update your payment method to continue uploading." };

    default:
      return { allow: false, message: "Your subscription is not active. Subscribe to continue uploading." };
  }
}
