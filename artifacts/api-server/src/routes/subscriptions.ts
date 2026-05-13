import { Router } from "express";
import Stripe from "stripe";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();
const stripeKey = process.env["STRIPE_SECRET_KEY"];
const stripe = stripeKey ? new Stripe(stripeKey) : null;
const PRICE_ID = process.env["STRIPE_PRICE_ID"] || "";

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
    if (!stripe) { res.status(503).json({ message: "Payment system not configured. Contact support." }); return; }
    const origin = req.headers["origin"] || "https://kkamera.app";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE_ID, quantity: 1 }],
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
    await db.update(subscriptionsTable).set({ status: "cancelled" }).where(eq(subscriptionsTable.userId, req.userId!));
    res.json({ message: "Subscription cancelled" });
  } catch (err) {
    req.log.error({ err }, "Cancel subscription error");
    res.status(500).json({ message: "Failed to cancel subscription" });
  }
});

export default router;
