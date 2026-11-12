import { Router } from "express";
import { z } from "zod";
import { db } from "@workspace/db";
import { cloudConnectionsTable, usersTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { localRateLimit, sharedRateLimit } from "../lib/rateLimitStore.js";
import { requireAuth } from "../middlewares/auth.js";
import { encrypt } from "../lib/crypto.js";
import {
  allowInsecureWebdav, purgeExpiredPendingConnections, revokeRemovedConnectionIfUnshared, testCloudConnection,
} from "../lib/cloudUpload.js";
import { DEFAULT_UPLOAD_PATH, MAX_CONNECTIONS_PER_USER, normalizeUploadPath } from "../lib/cloudUploadPolicy.js";
import { CONNECTION_LIMIT_MESSAGE, connectionCountLocked } from "../lib/connectionLimits.js";
import {
  connectionUpdatePlan, createConnectionSchema, retargetNeedsPassword, shouldClearTlsPin, updateConnectionSchema,
} from "../lib/cloudConnectionSchemas.js";
import { INSECURE_DAV_MESSAGE, usesPlainHttp } from "../lib/nextcloud.js";
import { retainTargetIds } from "../lib/accountRules.js";

const router = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Drop deleted connections from the user's "selected" upload target so new
 * captures aren't addressed to ids that no longer exist.
 */
async function pruneUploadTarget(tx: Tx, userId: number) {
  const [user] = await tx.select({ ids: usersTable.uploadTargetIds })
    .from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user?.ids) return;
  const remaining = await tx.select({ id: cloudConnectionsTable.id })
    .from(cloudConnectionsTable).where(eq(cloudConnectionsTable.userId, userId));
  const next = retainTargetIds(user.ids, remaining.map(r => r.id));
  if (next !== user.ids) {
    await tx.update(usersTable).set({ uploadTargetIds: next }).where(eq(usersTable.id, userId));
  }
}

/**
 * A confirmed connection of this user. Pending OAuth rows (awaiting
 * /oauth/complete from the device that started the flow) are invisible to
 * every route here — never listed, edited, tested or deleted individually.
 */
function ownConfirmed(id: number, userId: number) {
  return and(
    eq(cloudConnectionsTable.id, id),
    eq(cloudConnectionsTable.userId, userId),
    isNull(cloudConnectionsTable.pendingNonceHash),
  );
}

// A connection test makes the server connect to a user-chosen public host and
// port and reports whether it answered — a port-scan oracle if unthrottled.
// Keyed by the authenticated user (many users can share a carrier NAT).
const testLimiter = localRateLimit("cloudConnections.testLimiter", {
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { success: false, message: "Too many connection tests. Please wait a minute and try again." },
});

// Creating connections is cheap for a client but each one multiplies upload
// fan-out and outbound connection tests, so bound the rate per account as well
// as the total (MAX_CONNECTIONS_PER_USER).
const createLimiter = sharedRateLimit("cloudConnections.createLimiter", {
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.userId}`,
  message: { message: "Too many new connections. Please try again later." },
});

/** WebDAV / Nextcloud over plain http:// sends Basic auth in cleartext — refused unless opted in. */
function insecureDavHost(type: string, host: string | null | undefined): boolean {
  return (type === "webdav" || type === "nextcloud") && usesPlainHttp(host) && !allowInsecureWebdav();
}

/**
 * Render the first validation issue, prefixed with the offending field. Zod's
 * default text ("Expected string, received null") is useless on its own when a
 * body has nine fields.
 */
function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
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
    // The pinned certificate fingerprint itself stays server-side.
    trustSelfSigned: c.trustSelfSigned,
    createdAt: c.createdAt.toISOString(),
  };
}

router.get("/cloud-connections", requireAuth, async (req, res) => {
  try {
    void purgeExpiredPendingConnections();
    const conns = await db.select().from(cloudConnectionsTable)
      .where(and(eq(cloudConnectionsTable.userId, req.userId!), isNull(cloudConnectionsTable.pendingNonceHash)));
    res.json(conns.map(formatConn));
  } catch (err) {
    req.log.error({ err }, "List cloud connections error");
    res.status(500).json({ message: "Failed to list connections" });
  }
});

router.post("/cloud-connections", requireAuth, createLimiter, async (req, res) => {
  try {
    const parsed = createConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: firstIssueMessage(parsed.error) });
      return;
    }
    // OAuth providers (Drive/OneDrive/Dropbox) are rejected by the schema: their
    // connections are created only by the OAuth callback + /oauth/complete, so
    // this route never stores an access token.
    const { type, provider, name, host, port, username, password, uploadPath, trustSelfSigned } = parsed.data;
    if (insecureDavHost(type, host)) {
      res.status(400).json({ message: `host: ${INSECURE_DAV_MESSAGE}` });
      return;
    }
    const conn = await db.transaction(async (tx) => {
      if (await connectionCountLocked(tx, req.userId!, { confirmedOnly: true }) >= MAX_CONNECTIONS_PER_USER) return "limit" as const;
      const [row] = await tx.insert(cloudConnectionsTable).values({
        userId: req.userId!, type, provider: provider ?? null, name,
        host: host ?? null,
        port: port ?? null,
        username: username || null,
        passwordEncrypted: password ? encrypt(password) : null,
        uploadPath: normalizeUploadPath(uploadPath ?? DEFAULT_UPLOAD_PATH),
        trustSelfSigned: trustSelfSigned ?? false,
        active: true,
      }).returning();
      return row;
    });
    if (conn === "limit") { res.status(409).json({ message: CONNECTION_LIMIT_MESSAGE }); return; }
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
    if (plan.trustSelfSigned !== undefined) updates.trustSelfSigned = plan.trustSelfSigned;

    // Checks against the stored row run under a row lock so a concurrent PATCH
    // can't change host/password between the check and this update.
    type Row = typeof cloudConnectionsTable.$inferSelect;
    type Outcome = { conn: Row } | { status: 400 | 404; message: string };
    const result = await db.transaction(async (tx): Promise<Outcome> => {
      const [existing] = await tx.select().from(cloudConnectionsTable)
        .where(ownConfirmed(id, req.userId!))
        .for("update")
        .limit(1);
      if (!existing) return { status: 404, message: "Connection not found" };
      // Nextcloud's DAV endpoint is built from the username — it can't be cleared.
      if (updates.username === null && existing.type === "nextcloud") {
        return { status: 400, message: "username: Nextcloud username is required" };
      }
      const retarget = retargetNeedsPassword(plan, {
        host: existing.host, port: existing.port, hasPassword: !!existing.passwordEncrypted,
      });
      if (retarget) return { status: 400, message: retarget };
      if (plan.host !== undefined && insecureDavHost(existing.type, plan.host)) {
        return { status: 400, message: `host: ${INSECURE_DAV_MESSAGE}` };
      }
      if (shouldClearTlsPin(plan, {
        host: existing.host, port: existing.port, trustSelfSigned: existing.trustSelfSigned,
      })) updates.tlsPinSha256 = null;
      if (Object.keys(updates).length === 0) return { conn: existing };
      const [conn] = await tx.update(cloudConnectionsTable).set(updates)
        .where(ownConfirmed(id, req.userId!))
        .returning();
      return conn ? { conn } : { status: 404, message: "Connection not found" };
    });
    if (!("conn" in result)) { res.status(result.status).json({ message: result.message }); return; }
    res.json(formatConn(result.conn));
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
    const removed = await db.transaction(async (tx) => {
      const rows = await tx.delete(cloudConnectionsTable)
        .where(eq(cloudConnectionsTable.userId, req.userId!))
        .returning();
      await pruneUploadTarget(tx, req.userId!);
      return rows;
    });
    res.json({ message: "All connections deleted" });
    // None of this user's rows survive, but another user's connection can ride
    // on the same provider account (same accountId), so each grant goes through
    // the shared-grant check. One check per distinct token is enough.
    const seen = new Set<string>();
    const toRevoke = removed.filter((c) => {
      const key = `${c.type}:${c.refreshToken ?? c.accessTokenEncrypted ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    void Promise.allSettled(toRevoke.map((c) => revokeRemovedConnectionIfUnshared(c)));
  } catch (err) {
    req.log.error({ err }, "Bulk delete cloud connections error");
    res.status(500).json({ message: "Failed to delete connections" });
  }
});

router.delete("/cloud-connections/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    const removed = await db.transaction(async (tx) => {
      const [row] = await tx.delete(cloudConnectionsTable)
        .where(ownConfirmed(id, req.userId!))
        .returning();
      if (row) await pruneUploadTarget(tx, req.userId!);
      return row;
    });
    res.json({ message: "Deleted" });
    // Runs after the response and never throws. A provider revoke kills the
    // whole grant (Google: every token for this app + account), so it is kept
    // while another connection may be riding on the same account (see
    // revokeRemovedConnectionIfUnshared).
    if (removed) void revokeRemovedConnectionIfUnshared(removed);
  } catch (err) {
    req.log.error({ err }, "Delete cloud connection error");
    res.status(500).json({ message: "Failed to delete connection" });
  }
});

router.post("/cloud-connections/:id/test", requireAuth, testLimiter, async (req, res) => {
  try {
    const id = parseInt(String(req.params["id"] ?? "0"));
    if (!id) { res.status(400).json({ message: "Invalid connection ID" }); return; }
    const [conn] = await db.select().from(cloudConnectionsTable)
      .where(ownConfirmed(id, req.userId!))
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
