import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.get("/users/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.userId!)).limit(1);
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ id: user.id, email: user.email, name: user.name, referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled, createdAt: user.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Get me error");
    res.status(500).json({ message: "Failed to get user" });
  }
});

router.patch("/users/me", requireAuth, async (req, res) => {
  try {
    const { name, email } = req.body as { name?: string; email?: string };
    const updates: Partial<{ name: string; email: string }> = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, req.userId!)).returning();
    if (!user) { res.status(404).json({ message: "User not found" }); return; }
    res.json({ id: user.id, email: user.email, name: user.name, referralCode: user.referralCode, twoFAEnabled: user.twoFAEnabled, createdAt: user.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Update me error");
    res.status(500).json({ message: "Failed to update user" });
  }
});

export default router;
