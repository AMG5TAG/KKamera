import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { feedbackTable } from "@workspace/db";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

const feedbackSchema = z.object({
  type: z.string().min(1).max(50),
  message: z.string().min(1).max(5000),
});

router.post("/feedback", requireAuth, async (req, res) => {
  try {
    const parsed = feedbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Type and message are required" });
      return;
    }
    const { type, message } = parsed.data;
    await db.insert(feedbackTable).values({ userId: req.userId!, type, message });
    res.status(201).json({ message: "Feedback submitted. Thank you!" });
  } catch (err) {
    req.log.error({ err }, "Feedback error");
    res.status(500).json({ message: "Failed to submit feedback" });
  }
});

export default router;
