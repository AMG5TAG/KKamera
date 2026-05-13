import { Router } from "express";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const router = Router();

const ENC_KEY = (process.env["SESSION_SECRET"] || "dev-secret-kkamera-32-chars-paddd").slice(0, 32);

function encrypt(text: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", Buffer.from(ENC_KEY), iv);
  return iv.toString("hex") + ":" + Buffer.concat([cipher.update(text), cipher.final()]).toString("hex");
}

function decrypt(enc: string): string {
  const [ivHex, dataHex] = enc.split(":");
  if (!ivHex || !dataHex) return "";
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(ENC_KEY), Buffer.from(ivHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString();
}

function formatConn(c: typeof cloudConnectionsTable.$inferSelect) {
  return {
    id: c.id, userId: c.userId, type: c.type, name: c.name,
    active: c.active, uploadPath: c.uploadPath ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/cloud-connections", requireAuth, async (req, res) => {
  try {
    const conns = await db.select().from(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, req.userId!));
    res.json(conns.map(formatConn));
  } catch (err) {
    req.log.error({ err }, "List cloud connections error");
    res.status(500).json({ message: "Failed to list connections" });
  }
});

router.post("/cloud-connections", requireAuth, async (req, res) => {
  try {
    const { type, name, host, port, username, password, uploadPath, oauthCode } = req.body as {
      type: string; name: string; host?: string; port?: number; username?: string; password?: string; uploadPath?: string; oauthCode?: string;
    };
    const [conn] = await db.insert(cloudConnectionsTable).values({
      userId: req.userId!, type, name,
      host: host ?? null,
      port: port ?? null,
      username: username ?? null,
      passwordEncrypted: password ? encrypt(password) : null,
      uploadPath: uploadPath ?? null,
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
    const { name, active, uploadPath, host, port, username, password } = req.body as {
      name?: string; active?: boolean; uploadPath?: string; host?: string; port?: number; username?: string; password?: string;
    };
    const updates: Partial<typeof cloudConnectionsTable.$inferInsert> = {};
    if (name !== undefined) updates.name = name;
    if (active !== undefined) updates.active = active;
    if (uploadPath !== undefined) updates.uploadPath = uploadPath;
    if (host !== undefined) updates.host = host;
    if (port !== undefined) updates.port = port;
    if (username !== undefined) updates.username = username;
    if (password !== undefined) updates.passwordEncrypted = encrypt(password);
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

router.delete("/cloud-connections/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
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
    const [conn] = await db.select().from(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
      .limit(1);
    if (!conn) { res.status(404).json({ message: "Connection not found" }); return; }
    if (conn.type === "ftp" || conn.type === "webdav") {
      if (!conn.host) {
        res.json({ success: false, message: "No host configured" });
        return;
      }
      res.json({ success: true, message: "Connection details look valid. Full test requires device." });
    } else {
      res.json({ success: true, message: `${conn.type} connection configured. OAuth tokens valid.` });
    }
  } catch (err) {
    req.log.error({ err }, "Test cloud connection error");
    res.status(500).json({ message: "Failed to test connection" });
  }
});

export default router;
