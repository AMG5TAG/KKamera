import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { subscriptionsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { evaluateAccess } from "../lib/subscriptionAccess.js";
import { isTesterEmail } from "../lib/testerAccess.js";

/** Blocks the request unless the user has an active subscription, valid trial,
 *  or a not-yet-expired cancelled/past_due subscription (see evaluateAccess).
 *  Alpha testers on TESTER_EMAILS are always allowed. */
export async function requireSubscription(req: Request, res: Response, next: NextFunction) {
  try {
    const [sub] = await db
      .select()
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, req.userId!))
      .limit(1);

    const decision = evaluateAccess(sub, new Date());
    if (!decision.allow && !(await isTesterUser(req.userId!))) {
      res.status(402).json({ message: decision.message });
      return;
    }
    next();
  } catch (err) {
    req.log.error({ err }, "Subscription check failed");
    res.status(500).json({ message: "Failed to verify subscription" });
  }
}

/** True when the user's email is on the TESTER_EMAILS allowlist. */
export async function isTesterUser(userId: number): Promise<boolean> {
  if (!process.env["TESTER_EMAILS"]) return false;
  const [u] = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  return isTesterEmail(u?.email);
}
