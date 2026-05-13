import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { uploadsTable, cloudConnectionsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { uploadToCloud } from "../lib/cloudUpload.js";
import { sendPushToUser } from "../lib/pushNotifications.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function fmt(u: typeof uploadsTable.$inferSelect) {
  return {
    id: u.id, userId: u.userId, fileName: u.fileName, fileType: u.fileType,
    status: u.status, connectionIds: u.connectionIds ?? null, error: u.error ?? null,
    createdAt: u.createdAt.toISOString(),
  };
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
    const [item] = await db.insert(uploadsTable).values({
      userId: req.userId!, fileName, fileType, status: "pending", connectionIds: connectionIds ?? null,
    }).returning();
    if (!item) { res.status(500).json({ message: "Failed to create upload" }); return; }
    res.status(201).json(fmt(item));
  } catch (err) {
    req.log.error({ err }, "Create upload error");
    res.status(500).json({ message: "Failed to create upload" });
  }
});

// ─── Execute upload: accepts multipart/form-data with a real file ─────────────
router.post("/uploads/execute", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) { res.status(400).json({ message: "No file provided" }); return; }

    const fileName: string = (req.body.fileName as string) || file.originalname || `upload_${Date.now()}`;
    const mimeType: string = (req.body.mimeType as string) || file.mimetype || "application/octet-stream";
    const fileType: string = mimeType.startsWith("video/") ? "video" : "image";

    let connectionIds: number[] | null = null;
    if (req.body.connectionIds) {
      try { connectionIds = JSON.parse(req.body.connectionIds); } catch { /* ignore */ }
    }

    // Fetch target connections (active, belonging to this user)
    const baseQuery = db.select().from(cloudConnectionsTable)
      .where(eq(cloudConnectionsTable.userId, req.userId!));

    const connections = connectionIds?.length
      ? await db.select().from(cloudConnectionsTable).where(
          and(
            eq(cloudConnectionsTable.userId, req.userId!),
            eq(cloudConnectionsTable.active, true),
            inArray(cloudConnectionsTable.id, connectionIds)
          )
        )
      : await db.select().from(cloudConnectionsTable).where(
          and(eq(cloudConnectionsTable.userId, req.userId!), eq(cloudConnectionsTable.active, true))
        );

    if (connections.length === 0) {
      // No connections — record and return queued
      const [item] = await db.insert(uploadsTable).values({
        userId: req.userId!, fileName, fileType, status: "queued",
        error: "No active cloud connections configured",
      }).returning();
      res.status(202).json({ uploadId: item?.id, results: [], status: "queued" });
      return;
    }

    // Create upload record
    const [uploadRecord] = await db.insert(uploadsTable).values({
      userId: req.userId!, fileName, fileType, status: "uploading",
      connectionIds: connections.map(c => c.id).join(","),
    }).returning();

    // Upload to all connections in parallel
    const results = await Promise.all(
      connections.map(conn => uploadToCloud(conn, file.buffer, fileName, mimeType))
    );

    const allOk = results.every(r => r.success);
    const anyOk = results.some(r => r.success);
    const finalStatus = allOk ? "done" : anyOk ? "partial" : "failed";
    const errorMsg = results
      .filter(r => !r.success)
      .map(r => r.error)
      .join("; ");

    if (uploadRecord) {
      await db.update(uploadsTable).set({
        status: finalStatus,
        error: errorMsg || null,
      }).where(eq(uploadsTable.id, uploadRecord.id));
    }

    // Push notification — fire and forget, never block the response
    if (uploadRecord?.userId) {
      const destination = connections[0]?.name ?? connections[0]?.type ?? "cloud";
      if (finalStatus === "done" || finalStatus === "partial") {
        sendPushToUser(uploadRecord.userId, { type: "upload_done", fileName, destination }).catch(() => {});
      } else if (finalStatus === "failed") {
        sendPushToUser(uploadRecord.userId, { type: "upload_failed", fileName }).catch(() => {});
      }
    }

    res.json({
      uploadId: uploadRecord?.id,
      status: finalStatus,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "Execute upload error");
    res.status(500).json({ message: "Upload failed", error: String((err as any)?.message ?? err) });
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
