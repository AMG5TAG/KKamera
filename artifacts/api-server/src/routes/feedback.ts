import { Router } from "express";
import { db } from "@workspace/db";
import { feedbackTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.post("/feedback", requireAuth, async (req, res) => {
  try {
    const { type, message } = req.body as { type: string; message: string };
    if (!type || !message) { res.status(400).json({ message: "Type and message are required" }); return; }
    await db.insert(feedbackTable).values({ userId: req.userId!, type, message });
    res.status(201).json({ message: "Feedback submitted. Thank you!" });
  } catch (err) {
    req.log.error({ err }, "Feedback error");
    res.status(500).json({ message: "Failed to submit feedback" });
  }
});

export default router;
