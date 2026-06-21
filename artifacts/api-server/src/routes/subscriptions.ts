import { Router } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { getUncachableStripeClient, getStripePublishableKey } from "../stripeClient.js";

const router = Router();

router.get("/subscriptions/me", requireAuth, async (req, res) => {
  try {
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);
    if (!sub) {
      res.json({ id: 0, userId: req.userId!, status: "none", trialEnd: null, currentPeriodEnd: null, createdAt: new Date().toISOString() });
      return;
    }
    res.json({
      id: sub.id, userId: sub.userId, status: sub.status,
      trialEnd: sub.trialEnd?.toISOString() ?? null,
      currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
      createdAt: sub.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Get subscription error");
    res.status(500).json({ message: "Failed to get subscription" });
  }
});

router.post("/subscriptions/trial", requireAuth, async (req, res) => {
  try {
    const existing = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);
    if (existing.length > 0) {
      const sub = existing[0]!;
      res.json({ id: sub.id, userId: sub.userId, status: sub.status, trialEnd: sub.trialEnd?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, createdAt: sub.createdAt.toISOString() });
      return;
    }
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 14);
    const [sub] = await db.insert(subscriptionsTable).values({ userId: req.userId!, status: "trial", trialStart: new Date(), trialEnd }).returning();
    if (!sub) { res.status(500).json({ message: "Failed to start trial" }); return; }
    res.json({ id: sub.id, userId: sub.userId, status: sub.status, trialEnd: sub.trialEnd?.toISOString() ?? null, currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null, createdAt: sub.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Start trial error");
    res.status(500).json({ message: "Failed to start trial" });
  }
});

router.post("/subscriptions/checkout", requireAuth, async (req, res) => {
  try {
    const stripe = await getUncachableStripeClient();

    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);

    let customerId = sub?.stripeCustomerId ?? undefined;
    if (!customerId) {
      const [user] = await db.select({ email: usersTable.email, name: usersTable.name })
        .from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
      const customer = await stripe.customers.create({
        ...(user?.email ? { email: user.email } : {}),
        ...(user?.name ? { name: user.name } : {}),
        metadata: { userId: String(req.userId) },
      });
      customerId = customer.id;
      if (sub) {
        await db.update(subscriptionsTable).set({ stripeCustomerId: customerId }).where(eq(subscriptionsTable.userId, req.userId!));
      } else {
        await db.insert(subscriptionsTable).values({ userId: req.userId!, status: "none", stripeCustomerId: customerId });
      }
    }

    const priceId: string = req.body?.priceId || process.env["STRIPE_PRICE_ID"] || "";
    if (!priceId) {
      res.status(503).json({ message: "No Stripe price configured. Contact support." });
      return;
    }

    const origin = req.headers["origin"] || `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/settings/subscription?success=true`,
      cancel_url: `${origin}/settings/subscription?cancelled=true`,
      metadata: { userId: String(req.userId) },
    });

    res.json({ url: session.url || "" });
  } catch (err) {
    req.log.error({ err }, "Checkout error");
    res.status(500).json({ message: "Failed to create checkout" });
  }
});

router.post("/subscriptions/cancel", requireAuth, async (req, res) => {
  try {
    const [sub] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, req.userId!)).limit(1);

    // Cancel the live Stripe subscription at period end so the user keeps the
    // access they've already paid for. The webhook flips local status to
    // "expired" when it actually ends — we do NOT revoke access here.
    if (sub?.stripeSubscriptionId) {
      const stripe = await getUncachableStripeClient();
      await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
      res.json({ message: "Subscription will not renew. You keep access until the end of the current period." });
      return;
    }

    // No active Stripe subscription (e.g. trial only) — nothing to bill, mark cancelled.
    await db.update(subscriptionsTable).set({ status: "cancelled" }).where(eq(subscriptionsTable.userId, req.userId!));
    res.json({ message: "Subscription cancelled" });
  } catch (err) {
    req.log.error({ err }, "Cancel subscription error");
    res.status(500).json({ message: "Failed to cancel subscription" });
  }
});

router.get("/subscriptions/publishable-key", async (_req, res) => {
  try {
    const key = await getStripePublishableKey();
    res.json({ publishableKey: key });
  } catch {
    res.status(503).json({ message: "Stripe not configured" });
  }
});

export default router;
