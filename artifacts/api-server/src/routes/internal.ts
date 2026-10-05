import { Router } from "express";
import { createHash, timingSafeEqual } from "crypto";
import { sweepTrialReminders } from "../lib/trialReminder.js";

const router = Router();

/** Constant-time bearer check against CRON_SECRET. Fails closed when unset. */
function cronAuthorized(header: string | undefined): boolean | null {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return null;
  if (!header?.startsWith("Bearer ")) return false;
  // Hash both sides so lengths match for timingSafeEqual.
  const a = createHash("sha256").update(header.slice(7)).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

// For an external scheduler (e.g. a daily cron hitting this URL). The same
// reminders are also sent opportunistically on user activity; both paths share
// an atomic per-user claim, so a user never gets it twice.
router.post("/internal/send-trial-reminders", async (req, res) => {
  const ok = cronAuthorized(req.headers["authorization"]);
  if (ok === null) { res.status(503).json({ message: "Not configured" }); return; }
  if (!ok) { res.status(401).json({ message: "Unauthorized" }); return; }
  try {
    const result = await sweepTrialReminders();
    req.log.info(result, "Trial reminder sweep complete");
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Trial reminder sweep error");
    res.status(500).json({ message: "Sweep failed" });
  }
});

export default router;
