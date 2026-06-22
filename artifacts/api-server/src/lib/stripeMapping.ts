// Pure mapping helpers for the Stripe webhook mirror — no DB/Stripe imports, so
// they can be unit-tested in isolation (see test/stripeMapping.test.ts).

/**
 * Extract the current period end from a Stripe Subscription object as a Date.
 * In API version 2025-08-27.basil, `current_period_end` moved from the
 * Subscription onto each subscription *item*. We take the furthest end across
 * all items (a multi-item/add-on subscription would otherwise pick an arbitrary
 * line), falling back to the legacy top-level field. Returns null if no valid
 * timestamp is present (never an Invalid Date).
 */
export function periodEndFromSubscription(sub: any): Date | null {
  const itemEnds: number[] = Array.isArray(sub?.items?.data)
    ? sub.items.data
        .map((i: any) => i?.current_period_end)
        .filter((n: unknown): n is number => typeof n === "number" && Number.isFinite(n))
    : [];
  const epochSeconds =
    itemEnds.length > 0
      ? Math.max(...itemEnds)
      : typeof sub?.current_period_end === "number" && Number.isFinite(sub.current_period_end)
        ? sub.current_period_end
        : null;
  return epochSeconds == null ? null : new Date(epochSeconds * 1000);
}

/**
 * Map a Stripe subscription status to our internal status. `null` means "leave
 * our stored status untouched" — used for transient/unknown Stripe states (e.g.
 * `incomplete` right after checkout, `paused`) so an out-of-order event can't
 * downgrade an active user.
 */
export function mapStripeStatus(stripeStatus: string): string | null {
  switch (stripeStatus) {
    case "active": return "active";
    case "trialing": return "trial";
    case "past_due":
    case "unpaid": return "past_due";
    case "canceled":
    case "incomplete_expired": return "expired";
    default: return null;
  }
}
