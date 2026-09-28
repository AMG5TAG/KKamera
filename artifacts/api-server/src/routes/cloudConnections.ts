import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { cloudConnectionsTable } from "@workspace/db";
import { eq, and, ne } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";
import { encrypt } from "../lib/crypto.js";
import { revokeProviderTokens, testCloudConnection } from "../lib/cloudUpload.js";
import { DEFAULT_UPLOAD_PATH, normalizeUploadPath } from "../lib/cloudUploadPolicy.js";
import { connectionUpdatePlan, createConnectionSchema, updateConnectionSchema } from "../lib/cloudConnectionSchemas.js";
import { logger } from "../lib/logger.js";

const router = Router();

/** Providers with a token-revocation endpoint (see revokeProviderTokens). */
const REVOCABLE = new Set(["googledrive", "dropbox"]);

/**
 * Revoke provider grants for deleted connections without holding up the
 * response — deletion already happened and never depends on the provider.
 */
function revokeInBackground(conns: Array<typeof cloudConnectionsTable.$inferSelect>): void {
  const targets = conns.filter((c) => REVOCABLE.has(c.type) && (c.refreshToken || c.accessTokenEncrypted));
  if (targets.length === 0) return;
  void Promise.allSettled(targets.map((c) => revokeProviderTokens(c))).then(() => {
    logger.info({ count: targets.length }, "Revoked provider tokens for deleted connections");
  });
}

/**
 * Render the first validation issue, prefixed with the offending field. Zod's
 * default text ("Expected string, received null") is useless on its own when a
 * body has nine fields.
 */
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.errors[0];
  if (!issue) return "Invalid request";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}

function formatConn(c: typeof cloudConnectionsTable.$inferSelect) {
  return {
    id: c.id, userId: c.userId, type: c.type, provider: c.provider ?? null, name: c.name,
    active: c.active, uploadPath: c.uploadPath ?? null,
    // The server URL the user typed. Not a secret (credentials stay behind
    // `hasCredentials`), and the app needs it to open a self-hosted cloud's
    // own web UI. Only ever returned to the owning user.
    host: c.host ?? null,
    // Non-secret connection settings, returned so the app's edit form can
    // prefill them. The password is never returned — only `hasPassword`.
    port: c.port ?? null,
    username: c.username ?? null,
    hasPassword: !!c.passwordEncrypted,
    accountLabel: c.accountLabel ?? null,
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
      res.status(400).json({ message: firstIssueMessage(parsed.error) });
      return;
    }
    const { type, provider, name, host, port, username, password, uploadPath, oauthCode } = parsed.data;
    const [conn] = await db.insert(cloudConnectionsTable).values({
      userId: req.userId!, type, provider: provider ?? null, name,
      host: host ?? null,
      port: port ?? null,
      username: username ?? null,
      passwordEncrypted: password ? encrypt(password) : null,
      accessTokenEncrypted: oauthCode ? encrypt(oauthCode) : null,
      uploadPath: normalizeUploadPath(uploadPath ?? DEFAULT_UPLOAD_PATH),
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
      res.status(400).json({ message: firstIssueMessage(parsed.error) });
      return;
    }
    // Absent = unchanged, null = clear (see updateConnectionSchema).
    const plan = connectionUpdatePlan(parsed.data);
    const updates: Partial<typeof cloudConnectionsTable.$inferInsert> = {};
    if (plan.name !== undefined) updates.name = plan.name;
    if (plan.active !== undefined) updates.active = plan.active;
    if (plan.uploadPath !== undefined) updates.uploadPath = normalizeUploadPath(plan.uploadPath ?? DEFAULT_UPLOAD_PATH);
    if (plan.host !== undefined) updates.host = plan.host;
    if (plan.port !== undefined) updates.port = plan.port;
    if (plan.username !== undefined) updates.username = plan.username;
    if (plan.password !== undefined) updates.passwordEncrypted = plan.password === null ? null : encrypt(plan.password);
    if (plan.oauthCode !== undefined) updates.accessTokenEncrypted = encrypt(plan.oauthCode);

    // Nextcloud's DAV endpoint is built from the username — it can't be cleared.
    if (updates.username === null) {
      const [existing] = await db.select({ type: cloudConnectionsTable.type }).from(cloudConnectionsTable)
        .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
        .limit(1);
      if (!existing) { res.status(404).json({ message: "Connection not found" }); return; }
      if (existing.type === "nextcloud") {
        res.status(400).json({ message: "username: Nextcloud username is required" });
        return;
      }
    }
    if (Object.keys(updates).length === 0) {
      const [current] = await db.select().from(cloudConnectionsTable)
        .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
        .limit(1);
      if (!current) { res.status(404).json({ message: "Connection not found" }); return; }
      res.json(formatConn(current));
      return;
    }
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
    const removed = await db.delete(cloudConnectionsTable)
      .where(eq(cloudConnectionsTable.userId, req.userId!))
      .returning();
    res.json({ message: "All connections deleted" });
    // Every row is gone, so no surviving connection can share a grant. One
    // revoke per distinct token is enough.
    const seen = new Set<string>();
    const toRevoke = removed.filter((c) => {
      const key = `${c.type}:${c.refreshToken ?? c.accessTokenEncrypted ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    revokeInBackground(toRevoke);
  } catch (err) {
    req.log.error({ err }, "Bulk delete cloud connections error");
    res.status(500).json({ message: "Failed to delete connections" });
  }
});

router.delete("/cloud-connections/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    const [removed] = await db.delete(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.id, id), eq(cloudConnectionsTable.userId, req.userId!)))
      .returning();
    res.json({ message: "Deleted" });
    if (removed && REVOCABLE.has(removed.type)) {
      // Runs after the response; must never throw into the handler.
      void (async () => {
        // A provider revoke kills the whole grant (Google: every token for this
        // app + account). Keep it if another of the user's connections may be
        // riding on the same account — same accountId, or either unidentified.
        const siblings = await db.select({ accountId: cloudConnectionsTable.accountId })
          .from(cloudConnectionsTable)
          .where(and(
            eq(cloudConnectionsTable.userId, removed.userId),
            eq(cloudConnectionsTable.type, removed.type),
            ne(cloudConnectionsTable.id, removed.id),
          ));
        const shared = siblings.some((c) => !c.accountId || !removed.accountId || c.accountId === removed.accountId);
        if (!shared) revokeInBackground([removed]);
      })().catch((err) => logger.info({ err, connectionId: removed.id }, "Token revoke skipped"));
    }
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
