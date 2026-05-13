import { Router } from "express";
import { db } from "@workspace/db";
import { uploadsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

function fmt(u: typeof uploadsTable.$inferSelect) {
  return { id: u.id, userId: u.userId, fileName: u.fileName, fileType: u.fileType, status: u.status, connectionIds: u.connectionIds ?? null, error: u.error ?? null, createdAt: u.createdAt.toISOString() };
}

router.get("/uploads", requireAuth, async (req, res) => {
  try {
    const items = await db.select().from(uploadsTable).where(eq(uploadsTable.userId, req.userId!));
    res.json(items.map(fmt));
  } catch (err) {
    req.log.error({ err }, "List uploads error");
    res.status(500).json({ message: "Failed to list uploads" });
  }
});

router.post("/uploads", requireAuth, async (req, res) => {
  try {
    const { fileName, fileType, connectionIds } = req.body as { fileName: string; fileType: string; connectionIds?: string };
    const [item] = await db.insert(uploadsTable).values({ userId: req.userId!, fileName, fileType, status: "pending", connectionIds: connectionIds ?? null }).returning();
    if (!item) { res.status(500).json({ message: "Failed to create upload" }); return; }
    res.status(201).json(fmt(item));
  } catch (err) {
    req.log.error({ err }, "Create upload error");
    res.status(500).json({ message: "Failed to create upload" });
  }
});

router.patch("/uploads/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    const { status, error } = req.body as { status?: string; error?: string };
    const updates: Partial<typeof uploadsTable.$inferInsert> = {};
    if (status !== undefined) updates.status = status;
    if (error !== undefined) updates.error = error;
    const [item] = await db.update(uploadsTable).set(updates)
      .where(and(eq(uploadsTable.id, id), eq(uploadsTable.userId, req.userId!)))
      .returning();
    if (!item) { res.status(404).json({ message: "Upload not found" }); return; }
    res.json(fmt(item));
  } catch (err) {
    req.log.error({ err }, "Update upload error");
    res.status(500).json({ message: "Failed to update upload" });
  }
});

router.delete("/uploads/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    await db.delete(uploadsTable).where(and(eq(uploadsTable.id, id), eq(uploadsTable.userId, req.userId!)));
    res.json({ message: "Deleted" });
  } catch (err) {
    req.log.error({ err }, "Delete upload error");
    res.status(500).json({ message: "Failed to delete upload" });
  }
});

export default router;
