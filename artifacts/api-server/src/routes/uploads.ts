import fs from "fs";
import os from "os";
import path from "path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { db } from "@workspace/db";
import { uploadsTable, cloudConnectionsTable, usersTable } from "@workspace/db";
import { eq, and, inArray, desc, lt, isNull } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { requireSubscription } from "../middlewares/requireSubscription.js";
import { logger } from "../lib/logger.js";
import { uploadToCloud } from "../lib/cloudUpload.js";
import { sendEmail, escapeHtml } from "../lib/email.js";
import { normalizeConnectionIds } from "../lib/connectionIds.js";
import { MAX_UPLOAD_FILENAME_LENGTH, isAllowedMimeType, parseConnectionIdsField } from "../lib/cloudUploadPolicy.js";
import {
  STALE_UPLOADING_MS, decideExistingUpload, isUniqueViolation, mergeUploadOutcome, parseClientUploadIdField,
} from "../lib/uploadDedupe.js";

const router = Router();

// Stream uploads to a temp file on disk rather than buffering the whole body in
// RAM. memoryStorage held the entire file (up to the cap) in memory for every
// concurrent request, so a handful of large videos could OOM-kill the shared
// instance and drop all users. The providers then stream from that file (FTP,
// WebDAV) or read it one chunk at a time (Drive/OneDrive/Dropbox sessions), so
// the whole file is never in memory during the cloud upload either.
const UPLOAD_TMP_PREFIX = "kkamera-upload-";
const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) => cb(null, `${UPLOAD_TMP_PREFIX}${Date.now()}-${Math.round(Math.random() * 1e9)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

// Temp files are unlinked when their request finishes, but a crash or restart
// mid-request leaves them behind. Sweep ones older than any live request can be
// (uploads are bounded by MAX_UPLOAD_DEADLINE_MS) at startup and hourly.
const TMP_SWEEP_AGE_MS = 60 * 60_000;
const UPLOAD_TMP_RE = /^kkamera-upload-\d+-\d+$/;

async function sweepOrphanedUploadTempFiles(): Promise<void> {
  const dir = os.tmpdir();
  let removed = 0;
  try {
    const names = await fs.promises.readdir(dir);
    const cutoff = Date.now() - TMP_SWEEP_AGE_MS;
    for (const name of names) {
      if (!name.startsWith(UPLOAD_TMP_PREFIX) || !UPLOAD_TMP_RE.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fs.promises.lstat(full);
        if (st.isFile() && st.mtimeMs < cutoff) {
          await fs.promises.unlink(full);
          removed += 1;
        }
      } catch { /* raced with the owning request's own unlink */ }
    }
  } catch (err) {
    logger.warn({ err }, "Upload temp-file sweep failed");
    return;
  }
  if (removed > 0) logger.info({ removed }, "Removed orphaned upload temp files");
}

void sweepOrphanedUploadTempFiles();
setInterval(() => { void sweepOrphanedUploadTempFiles(); }, TMP_SWEEP_AGE_MS).unref();

// Cap concurrent in-flight cloud uploads so outbound bandwidth, open files and
// chunk buffers stay bounded regardless of how many clients upload at once. Excess
// requests wait for a slot, but the wait queue itself is bounded too: once it is
// full new uploads get 503 + Retry-After (the app's offline queue retries them),
// instead of piling up temp files and open sockets without limit.
const MAX_CONCURRENT_UPLOADS = 3;
const MAX_UPLOAD_WAITERS = 20;
// Per-user in-flight cap, so one account (or a stolen token) can't occupy every
// global slot and starve everyone else.
const MAX_UPLOADS_PER_USER = 2;
const RETRY_AFTER_SECONDS = 30;
let activeUploads = 0;
const uploadWaiters: Array<() => void> = [];
const userInFlight = new Map<number, number>();

function uploadQueueFull(): boolean {
  return activeUploads >= MAX_CONCURRENT_UPLOADS && uploadWaiters.length >= MAX_UPLOAD_WAITERS;
}

/** Resolves when a slot is held; null when the wait queue is full (caller must not release). */
function acquireUploadSlot(): Promise<void> | null {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads += 1;
    return Promise.resolve();
  }
  if (uploadWaiters.length >= MAX_UPLOAD_WAITERS) return null;
  // Inherit the releaser's slot (activeUploads stays at the cap) when resumed.
  return new Promise<void>(resolve => uploadWaiters.push(resolve));
}

function releaseUploadSlot(): void {
  const next = uploadWaiters.shift();
  if (next) next(); // hand our slot straight to the next waiter
  else activeUploads -= 1;
}

function sendBusy(res: Response, status: 409 | 429 | 503, message: string): void {
  res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
  res.status(status).json({ message });
}

/**
 * Admission control for /uploads/execute, run *before* multer so a rejected
 * request never writes its body to disk. Holds one of the user's in-flight
 * slots until the handler finishes (res.locals.releaseUserUploadSlot), or until
 * the response closes if the handler never ran (e.g. multer rejected the body).
 */
function uploadAdmission(req: Request, res: Response, next: NextFunction): void {
  if (uploadQueueFull()) {
    sendBusy(res, 503, "Upload server is busy. Please try again shortly.");
    return;
  }
  const userId = req.userId!;
  const inFlight = userInFlight.get(userId) ?? 0;
  if (inFlight >= MAX_UPLOADS_PER_USER) {
    sendBusy(res, 429, "Too many uploads in progress. Please wait for one to finish.");
    return;
  }
  userInFlight.set(userId, inFlight + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (userInFlight.get(userId) ?? 1) - 1;
    if (n <= 0) userInFlight.delete(userId);
    else userInFlight.set(userId, n);
  };
  res.locals["releaseUserUploadSlot"] = release;
  res.once("close", () => { if (!res.locals["uploadHandlerStarted"]) release(); });
  next();
}

// Per-user request rate on top of the concurrency cap (keyed by the
// authenticated user, not IP — many users can share a carrier NAT).
const executeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { message: "Too many uploads. Please try again shortly." },
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

const UPLOAD_STATUS_VALUES = ["pending", "queued", "uploading", "done", "failed", "partial"] as const;

const updateUploadSchema = z.object({
  status: z.enum(UPLOAD_STATUS_VALUES).optional(),
  error: z.string().max(2000).optional(),
}).strict();

function fmt(u: typeof uploadsTable.$inferSelect) {
  return {
    id: u.id, userId: u.userId, fileName: u.fileName, fileType: u.fileType,
    status: u.status, connectionIds: u.connectionIds ?? null, error: u.error ?? null,
    clientUploadId: u.clientUploadId ?? null,
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
      // Normalise to the same CSV-of-ids representation /uploads/execute writes,
      // so the stored field has one consistent format across both paths.
      connectionIds: normalizeConnectionIds(connectionIds),
    }).returning();
    if (!item) { res.status(500).json({ message: "Failed to create upload" }); return; }
    res.status(201).json(fmt(item));
  } catch (err) {
    req.log.error({ err }, "Create upload error");
    res.status(500).json({ message: "Failed to create upload" });
  }
});

// ─── Execute upload — requires active subscription ────────────────────────────

type UploadRow = typeof uploadsTable.$inferSelect;

async function findByClientUploadId(userId: number, clientUploadId: string): Promise<UploadRow | undefined> {
  const [row] = await db.select().from(uploadsTable).where(
    and(eq(uploadsTable.userId, userId), eq(uploadsTable.clientUploadId, clientUploadId))
  ).limit(1);
  return row;
}

type ClaimResult =
  | { kind: "claimed"; row: UploadRow; previous: UploadRow | null }
  | { kind: "done"; row: UploadRow }
  | { kind: "busy" };

/**
 * Take ownership of the history row for one capture. Without a clientUploadId
 * this is a plain insert. With one, an existing row is reused (never
 * duplicated): a finished row short-circuits as "done", a row another request
 * is still uploading is "busy", anything else is claimed with a conditional
 * update so two concurrent retries can't both own it. A unique violation on
 * insert means a concurrent request created the row first — re-read and decide
 * again.
 */
async function claimUploadRow(
  userId: number,
  clientUploadId: string | null,
  values: { fileName: string; fileType: string; status: string; connectionIds: string | null; error: string | null },
): Promise<ClaimResult> {
  if (!clientUploadId) {
    const [row] = await db.insert(uploadsTable).values({ userId, ...values }).returning();
    if (!row) throw new Error("Failed to create upload record");
    return { kind: "claimed", row, previous: null };
  }
  for (let i = 0; i < 3; i++) {
    const existing = await findByClientUploadId(userId, clientUploadId);
    const decision = decideExistingUpload(existing);
    if (decision.action === "done") return { kind: "done", row: existing! };
    if (decision.action === "busy") return { kind: "busy" };
    if (decision.action === "insert") {
      try {
        const [row] = await db.insert(uploadsTable).values({ userId, clientUploadId, ...values }).returning();
        if (!row) throw new Error("Failed to create upload record");
        return { kind: "claimed", row, previous: null };
      } catch (err) {
        if (isUniqueViolation(err)) continue;
        throw err;
      }
    }
    const prev = existing!;
    // Keep every destination the capture has ever been sent to on the row.
    const connectionIds = [...new Set(
      [prev.connectionIds, values.connectionIds].filter(Boolean).join(",").split(",").filter(Boolean)
    )].join(",") || null;
    const [row] = await db.update(uploadsTable).set({ ...values, connectionIds }).where(and(
      eq(uploadsTable.id, prev.id),
      eq(uploadsTable.status, prev.status),
      prev.status === "uploading"
        ? lt(uploadsTable.updatedAt, new Date(Date.now() - STALE_UPLOADING_MS))
        : undefined,
    )).returning();
    if (row) return { kind: "claimed", row, previous: prev };
    // Another request changed the row between our read and update — re-read.
  }
  return { kind: "busy" };
}

function sendDuplicateBusy(res: Response): void {
  sendBusy(res, 409, "This capture is already being uploaded. Please try again shortly.");
}

function sendAlreadyDone(res: Response, row: UploadRow): void {
  res.json({ uploadId: row.id, status: "done", results: [], duplicate: true });
}

router.post(
  "/uploads/execute",
  requireAuth,
  requireSubscription,
  executeLimiter,
  uploadAdmission,
  upload.single("file"),
  async (req, res) => {
    res.locals["uploadHandlerStarted"] = true;
    const releaseUserSlot = res.locals["releaseUserUploadSlot"] as (() => void) | undefined;
    const tmpPath = req.file?.path;
    try {
      const file = req.file;
      if (!file) { res.status(400).json({ message: "No file provided" }); return; }

      const rawName: unknown = req.body.fileName;
      if (rawName !== undefined && typeof rawName !== "string") {
        res.status(400).json({ message: "Invalid fileName" }); return;
      }
      const fileName: string = rawName || file.originalname || `upload_${Date.now()}`;
      if (fileName.length > MAX_UPLOAD_FILENAME_LENGTH) {
        res.status(400).json({ message: `fileName must be at most ${MAX_UPLOAD_FILENAME_LENGTH} characters` }); return;
      }

      // An explicit mimeType must be a plain image/* or video/* type — it is
      // written into provider request bodies/headers (e.g. the Drive multipart
      // part), so CR/LF or parameters are refused outright.
      const rawMime: unknown = req.body.mimeType;
      if (rawMime !== undefined && rawMime !== "" && !isAllowedMimeType(rawMime)) {
        res.status(400).json({ message: "Unsupported mimeType (expected image/* or video/*)" }); return;
      }
      const mimeType: string = isAllowedMimeType(rawMime) ? rawMime
        : isAllowedMimeType(file.mimetype) ? file.mimetype
        : "application/octet-stream";
      const fileType: string = mimeType.startsWith("video/") ? "video" : "image";

      // Absent → all active connections. Present but malformed/empty → 400,
      // never a silent fallback to uploading everywhere.
      const idsField = parseConnectionIdsField(req.body.connectionIds);
      if (!idsField.ok) {
        res.status(400).json({ message: "connectionIds must be a non-empty JSON array of connection IDs" }); return;
      }
      const connectionIds = idsField.ids;

      // Stable per-capture id from the app, used to recognise retries.
      const clientIdField = parseClientUploadIdField(req.body.clientUploadId);
      if (!clientIdField.ok) {
        res.status(400).json({ message: "clientUploadId must be at most 100 characters of A-Z, a-z, 0-9, _ or -" }); return;
      }
      const clientUploadId = clientIdField.id;

      // Cheap early exit for retries of a capture that already finished or is
      // still in flight, before touching connections or reading the file.
      if (clientUploadId) {
        const existing = await findByClientUploadId(req.userId!, clientUploadId);
        const decision = decideExistingUpload(existing);
        if (decision.action === "done") { sendAlreadyDone(res, existing!); return; }
        if (decision.action === "busy") { sendDuplicateBusy(res); return; }
      }

      // Only the user's active, CONFIRMED connections — never a pending OAuth
      // row awaiting /oauth/complete — whether the ids were named explicitly
      // (incl. an upload-target "selected" list) or it is "all".
      const usable = and(
        eq(cloudConnectionsTable.userId, req.userId!),
        eq(cloudConnectionsTable.active, true),
        isNull(cloudConnectionsTable.pendingNonceHash),
      );
      const connections = await db.select().from(cloudConnectionsTable).where(
        connectionIds ? and(usable, inArray(cloudConnectionsTable.id, connectionIds)) : usable
      );

      // Collapse duplicate active rows that point at the same cloud account
      // (possible if an identity lookup failed on a prior reconnect) so a single
      // capture is never uploaded twice to the same account.
      const seenAccounts = new Set<string>();
      const targets = connections.filter(c => {
        const key = c.accountId ? `${c.type}:${c.accountId}` : `id:${c.id}`;
        if (seenAccounts.has(key)) return false;
        seenAccounts.add(key);
        return true;
      });

      if (targets.length === 0) {
        const claim = await claimUploadRow(req.userId!, clientUploadId, {
          fileName, fileType, status: "queued", connectionIds: null,
          error: "No active cloud connections configured",
        });
        if (claim.kind === "done") { sendAlreadyDone(res, claim.row); return; }
        if (claim.kind === "busy") { sendDuplicateBusy(res); return; }
        res.status(202).json({ uploadId: claim.row.id, results: [], status: "queued" });
        return;
      }

      // Upload (streaming from the temp file) only while holding a slot, then
      // release it before the DB write. Each provider upload carries its own
      // deadline (see uploadToCloud), so a slot is always released even if a
      // remote stalls.
      const slot = acquireUploadSlot();
      if (!slot) {
        sendBusy(res, 503, "Upload server is busy. Please try again shortly.");
        return;
      }
      await slot;
      let uploadRecord: UploadRow | undefined;
      let previousRecord: UploadRow | null = null;
      let results;
      try {
        const claim = await claimUploadRow(req.userId!, clientUploadId, {
          fileName, fileType, status: "uploading",
          connectionIds: targets.map(c => c.id).join(","), error: null,
        });
        if (claim.kind === "done") { sendAlreadyDone(res, claim.row); return; }
        if (claim.kind === "busy") { sendDuplicateBusy(res); return; }
        uploadRecord = claim.row;
        previousRecord = claim.previous;
        const source = { path: file.path, size: file.size };
        results = await Promise.all(
          targets.map(conn => uploadToCloud(conn, source, fileName, mimeType))
        );
      } catch (err) {
        // Never leave a claimed row stuck in "uploading" — that would make every
        // retry of this capture 409 until the row goes stale.
        if (uploadRecord) {
          await db.update(uploadsTable).set({ status: "failed", error: "Upload failed" })
            .where(eq(uploadsTable.id, uploadRecord.id)).catch(() => {});
        }
        throw err;
      } finally {
        releaseUploadSlot();
      }

      // Combine with any previous attempt on the same row (a partial retry only
      // re-sends the destinations that failed). uploadToCloud already maps
      // errors to generic per-provider text.
      const outcome = mergeUploadOutcome(previousRecord, results);
      const finalStatus = outcome.status;

      await db.update(uploadsTable).set({
        status: finalStatus,
        connectionIds: outcome.connectionIds,
        error: outcome.error,
      }).where(eq(uploadsTable.id, uploadRecord.id));

      res.json({ uploadId: uploadRecord.id, status: finalStatus, results });
    } catch (err) {
      req.log.error({ err }, "Execute upload error");
      // Don't leak internal error details to the client; they're in the logs.
      if (!res.headersSent) res.status(500).json({ message: "Upload failed" });
    } finally {
      // Always remove the temp file and free the user's in-flight slot, on every
      // path (validation 400, busy 503, success, error).
      if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
      releaseUserSlot?.();
    }
  }
);

router.patch("/uploads/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid upload ID" }); return; }
    const parsed = updateUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { status, error } = parsed.data;
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

// Witness emails go to arbitrary addresses from our sending domain — rate limit
// per IP to prevent the endpoint being used as a spam/phishing relay.
const witnessLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many witness notifications. Please try again later." },
});

const witnessSchema = z.object({
  witnessEmail: z.string().email(),
  fileName: z.string().min(1).max(500),
});

router.post("/uploads/witness-notify", requireAuth, witnessLimiter, async (req, res) => {
  try {
    const parsed = witnessSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ message: "Invalid request" }); return; }
    const { witnessEmail, fileName } = parsed.data;

    const [user] = await db.select({ name: usersTable.name }).from(usersTable)
      .where(eq(usersTable.id, req.userId!)).limit(1);

    const userName = user?.name ?? "A KKamera user";
    const safeUserName = escapeHtml(userName);
    const safeFileName = escapeHtml(fileName);
    // Email headers are line-delimited — strip CR/LF (and collapse whitespace) from
    // any user-derived value used in the Subject so a crafted name can't inject
    // additional headers.
    const subjectName = userName.replace(/[\r\n\t]+/g, " ").trim().slice(0, 100) || "A KKamera user";
    const timestamp = new Date().toLocaleString("en-AU", { timeZone: "UTC", dateStyle: "short", timeStyle: "medium" });

    await sendEmail({
      to: witnessEmail,
      subject: `Witness notification: ${subjectName} captured a file`,
      html: `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#0d0b08;color:#ccc;padding:40px">
        <div style="max-width:480px;margin:0 auto;background:#1a1710;border-radius:16px;padding:28px;border:1px solid rgba(177,152,112,0.2)">
          <p style="color:#b19870;font-size:20px;font-weight:700;margin:0 0 20px">KKamera — Witness Notification</p>
          <p><strong style="color:white">${safeUserName}</strong> captured and uploaded a file to their cloud storage.</p>
          <p style="color:#888">File: <code style="color:#b19870">${safeFileName}</code></p>
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
