import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { encrypt } from "../lib/crypto.js";
import { testCloudConnection } from "../lib/cloudUpload.js";
import { CLOUD_PROVIDER } from "../lib/constants.js";

const router = Router();

const cloudProviders = Object.values(CLOUD_PROVIDER) as [string, ...string[]];

const createConnectionSchema = z.object({
  type: z.enum(cloudProviders as [string, ...string[]]),
  name: z.string().min(1).max(100),
  host: z.string().url().optional().or(z.string().min(1)).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  uploadPath: z.string().max(500).optional(),
  oauthCode: z.string().max(2000).optional(),
});

const updateConnectionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  active: z.boolean().optional(),
  uploadPath: z.string().max(500).optional(),
  host: z.string().max(500).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  oauthCode: z.string().max(2000).optional(),
}).strict();

function formatConn(c: typeof cloudConnectionsTable.$inferSelect) {
  return {
    id: c.id, userId: c.userId, type: c.type, name: c.name,
    active: c.active, uploadPath: c.uploadPath ?? null,
    hasCredentials: !!(c.passwordEncrypted || c.accessTokenEncrypted),
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/cloud-connections", requireAuth, async (req, res) => {
  try {
    const conns = await db.select().from(cloudConnectionsTable)
      .where(eq(cloudConnectionsTable.userId, req.userId!));
    res.json(conns.map(formatConn));
  } catch (err) {
    req.log.error({ err }, "List cloud connections error");
    res.status(500).json({ message: "Failed to list connections" });
  }
});

router.post("/cloud-connections", requireAuth, async (req, res) => {
  try {
    const parsed = createConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { type, name, host, port, username, password, uploadPath, oauthCode } = parsed.data;
    const [conn] = await db.insert(cloudConnectionsTable).values({
      userId: req.userId!, type, name,
      host: host ?? null,
      port: port ?? null,
      username: username ?? null,
      passwordEncrypted: password ? encrypt(password) : null,
      accessTokenEncrypted: oauthCode ? encrypt(oauthCode) : null,
      uploadPath: uploadPath ?? "/KKamera",
      active: true,
    }).returning();
    if (!conn) { res.status(500).json({ message: "Failed to create connection" }); return; }
    res.status(201).json(formatConn(conn));
  } catch (err) {
    req.log.error({ err }, "Create cloud connection error");
    res.status(500).json({ message: "Failed to create connection" });
  }
});

router.patch("/cloud-connections/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    const parsed = updateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: parsed.error.errors[0]?.message ?? "Invalid request" });
      return;
    }
    const { name, active, uploadPath, host, port, username, password, oauthCode } = parsed.data;
    const updates: Partial<typeof cloudConnectionsTable.$inferInsert> = {};
    if (name !== undefined) updates.name = name;
    if (active !== undefined) updates.active = active;
    if (uploadPath !== undefined) updates.uploadPath = uploadPath;
    if (host !== undefined) updates.host = host;
    if (port !== undefined) updates.port = port;
    if (username !== undefined) updates.username = username;
    if (password !== undefined) updates.passwordEncrypted = encrypt(password);
    if (oauthCode !== undefined) updates.accessTokenEncrypted = encrypt(oauthCode);
    const [conn] = await db.update(cloudConnectionsTable).set(updates)
      .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
      .returning();
    if (!conn) { res.status(404).json({ message: "Connection not found" }); return; }
    res.json(formatConn(conn));
  } catch (err) {
    req.log.error({ err }, "Update cloud connection error");
    res.status(500).json({ message: "Failed to update connection" });
  }
});

// Bulk delete — disconnect ALL of the user's cloud connections (used by the
// "panic wipe" privacy action). Must be registered before the "/:id" route is
// irrelevant (distinct path), but it is the endpoint the client relies on.
router.delete("/cloud-connections", requireAuth, async (req, res) => {
  try {
    await db.delete(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, req.userId!));
    res.json({ message: "All connections deleted" });
  } catch (err) {
    req.log.error({ err }, "Bulk delete cloud connections error");
    res.status(500).json({ message: "Failed to delete connections" });
  }
});

router.delete("/cloud-connections/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    await db.delete(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)));
    res.json({ message: "Deleted" });
  } catch (err) {
    req.log.error({ err }, "Delete cloud connection error");
    res.status(500).json({ message: "Failed to delete connection" });
  }
});

router.post("/cloud-connections/:id/test", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    const [conn] = await db.select().from(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
      .limit(1);
    if (!conn) { res.status(404).json({ message: "Connection not found" }); return; }
    const result = await testCloudConnection(conn);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Test cloud connection error");
    res.status(500).json({ success: false, message: "Test failed — server error" });
  }
});

export default router;
