import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { evaluateAccess } from "../lib/subscriptionAccess.js";

/** Blocks the request unless the user has an active subscription, valid trial,
 *  or a not-yet-expired cancelled/past_due subscription (see evaluateAccess). */
export async function requireSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.userId!))
      .limit(1);

    const decision = evaluateAccess(sub, new Date());
    if (!decision.allow) {
      res.status(402).json({ message: decision.message });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Subscription check failed");
    res.status(500).json({ message: "Failed to verify subscription" });
  }
}
