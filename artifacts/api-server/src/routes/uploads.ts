import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { db } from "@workspace/db";
import { uploadsTable, cloudConnectionsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { requireSubscription } from "../middlewares/requireSubscription.js";
import { uploadToCloud } from "../lib/cloudUpload.js";
import { sendPushToUser } from "../lib/pushNotifications.js";
import { sendEmail } from "../lib/email.js";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const createUploadSchema = z.object({
  fileName: z.string().min(1).max(500),
  fileType: z.enum(["image", "video"]),
  connectionIds: z.string().optional(),
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
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid query" });
      return;
    }
    const { limit, offset } = parsed.data;
    const items = await db
      .select()
      .from(uploadsTable)
      .where(eq(uploadsTable.userId, req.userId!))
      .orderBy(desc(uploadsTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json(items.map(fmt));
  } catch (err) {
    req.log.error({ err }, "List uploads error");
    res.status(500).json({ message: "Failed to list uploads" });
  }
});

router.post("/uploads", requireAuth, async (req, res) => {
  try {
    const parsed = createUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { fileName, fileType, connectionIds } = parsed.data;
    const [item] = await db.insert(uploadsTable).values({
      userId: req.userId!, fileName, fileType, status: "pending",
      connectionIds: connectionIds ?? null,
    }).returning();
    if (!item) { res.status(500).json({ message: "Failed to create upload" }); return; }
    res.status(201).json(fmt(item));
  } catch (err) {
    req.log.error({ err }, "Create upload error");
    res.status(500).json({ message: "Failed to create upload" });
  }
});

// ─── Execute upload — requires active subscription ────────────────────────────

router.post(
  "/uploads/execute",
  requireAuth,
  requireSubscription,
  upload.single("file"),
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) { res.status(400).json({ message: "No file provided" }); return; }

      const fileName: string = (req.body.fileName as string) || file.originalname || `upload_${Date.now()}`;
      const mimeType: string = (req.body.mimeType as string) || file.mimetype || "application/octet-stream";
      const fileType: string = mimeType.startsWith("video/") ? "video" : "image";

      let connectionIds: number[] | null = null;
      if (req.body.connectionIds) {
        try {
          const parsed = JSON.parse(req.body.connectionIds);
          if (Array.isArray(parsed) && parsed.every(n => typeof n === "number")) {
            connectionIds = parsed;
          }
        } catch { /* ignore malformed input */ }
      }

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
        const [item] = await db.insert(uploadsTable).values({
          userId: req.userId!, fileName, fileType, status: "queued",
          error: "No active cloud connections configured",
        }).returning();
        res.status(202).json({ uploadId: item?.id, results: [], status: "queued" });
        return;
      }

      const [uploadRecord] = await db.insert(uploadsTable).values({
        userId: req.userId!, fileName, fileType, status: "uploading",
        connectionIds: connections.map(c => c.id).join(","),
      }).returning();

      const results = await Promise.all(
        connections.map(conn => uploadToCloud(conn, file.buffer, fileName, mimeType))
      );

      const allOk = results.every(r => r.success);
      const anyOk = results.some(r => r.success);
      const finalStatus = allOk ? "done" : anyOk ? "partial" : "failed";
      const errorMsg = results.filter(r => !r.success).map(r => r.error).join("; ");

      if (uploadRecord) {
        await db.update(uploadsTable).set({
          status: finalStatus,
          error: errorMsg || null,
        }).where(eq(uploadsTable.id, uploadRecord.id));
      }

      if (uploadRecord?.userId) {
        const destination = connections[0]?.name ?? connections[0]?.type ?? "cloud";
        if (finalStatus === "done" || finalStatus === "partial") {
          sendPushToUser(uploadRecord.userId, { type: "upload_done", fileName, destination }).catch(() => {});
        } else if (finalStatus === "failed") {
          sendPushToUser(uploadRecord.userId, { type: "upload_failed", fileName }).catch(() => {});
        }
      }

      res.json({ uploadId: uploadRecord?.id, status: finalStatus, results });
    } catch (err) {
      req.log.error({ err }, "Execute upload error");
      res.status(500).json({ message: "Upload failed", error: String((err as any)?.message ?? err) });
    }
  }
);

router.patch("/uploads/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid upload ID" }); return; }
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
    if (!id) { res.status(400).json({ message: "Invalid upload ID" }); return; }
    await db.delete(uploadsTable).where(and(eq(uploadsTable.id, id), eq(uploadsTable.userId, req.userId!)));
    res.json({ message: "Deleted" });
  } catch (err) {
    req.log.error({ err }, "Delete upload error");
    res.status(500).json({ message: "Failed to delete upload" });
  }
});

router.delete("/uploads", requireAuth, async (req, res) => {
  try {
    await db.delete(uploadsTable).where(eq(uploadsTable.userId, req.userId!));
    res.json({ message: "History cleared" });
  } catch (err) {
    req.log.error({ err }, "Clear uploads error");
    res.status(500).json({ message: "Failed to clear history" });
  }
});

const witnessSchema = z.object({
  witnessEmail: z.string().email(),
  fileName: z.string().min(1).max(500),
});

router.post("/uploads/witness-notify", requireAuth, async (req, res) => {
  try {
    const parsed = witnessSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid request" }); return; }
    const { witnessEmail, fileName } = parsed.data;

    const [user] = await db.select({ name: usersTable.name }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).limit(1);

    const userName = user?.name ?? "A KKamera user";
    const timestamp = new Date().toLocaleString("en-AU", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium" });

    await sendEmail({
      to: witnessEmail,
      subject: `Witness notification: ${userName} captured a file`,
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d0b08;color:#ccc;padding:40px">
        <div style="max-width:480px;margin:0 auto;background:#1a1710;border-radius:16px;padding:28px;border:1px solid rgba(177,152,112,0.2)">
          <p style="color:#b19870;font-size:20px;font-weight:700;margin:0 0 20px">KKamera — Witness Notification</p>
          <p><strong style="color:white">${userName}</strong> captured and uploaded a file to their cloud storage.</p>
          <p style="color:#888">File: <code style="color:#b19870">${fileName}</code></p>
          <p style="color:#888">Time: ${timestamp} UTC</p>
          <p style="color:#666;font-size:12px;margin-top:20px">You received this because you are listed as a witness for this KKamera account.</p>
        </div></body></html>`,
    }).catch(() => {});

    res.json({ message: "Witness notified" });
  } catch (err) {
    req.log.error({ err }, "Witness notify error");
    res.status(500).json({ message: "Failed to notify witness" });
  }
});

export default router;
