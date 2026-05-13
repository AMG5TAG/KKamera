import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, referralsTable, subscriptionsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.get("/affiliates/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }

    const allReferrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, req.userId!));
    const completed = allReferrals.filter(r => r.status === "completed");
    const yearsEarned = Math.floor(completed.length / 5);

    res.json({
      referralCode: user.referralCode,
      totalReferrals: allReferrals.length,
      completedReferrals: completed.length,
      yearsEarned,
    });
  } catch (err) {
    req.log.error({ err }, "Affiliate stats error");
    res.status(500).json({ message: "Failed to get affiliate stats" });
  }
});

router.get("/affiliates/referrals", requireAuth, async (req, res) => {
  try {
    const referrals = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, req.userId!));
    res.json(referrals.map(r => ({
      id: r.id,
      referredName: r.referredName,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })));
  } catch (err) {
    req.log.error({ err }, "Get referrals error");
    res.status(500).json({ message: "Failed to get referrals" });
  }
});

export default router;
