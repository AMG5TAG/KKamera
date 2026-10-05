import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { maybeSendTrialReminder } from "../lib/trialReminder.js";
import { SESSION_AUDIENCE, isTokenVersionCurrent, parseSessionClaims } from "../lib/accountRules.js";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

// Validated at startup in index.ts — guaranteed to be set
export const JWT_SECRET = process.env["SESSION_SECRET"]!;

/**
 * Issue a session JWT. `tv` is the user's current token_version: bumping that
 * column revokes every session issued before (see requireAuth).
 */
export function issueSessionToken(userId: number, tokenVersion: number): string {
  return jwt.sign({ userId, tv: tokenVersion }, JWT_SECRET, {
    algorithm: "HS256",
    audience: SESSION_AUDIENCE,
    expiresIn: "30d",
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const token = auth.slice(7);
  let verified: unknown;
  try {
    // Pin the algorithm so a token can't be verified under an unexpected alg
    // (algorithm-confusion hardening).
    verified = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
  } catch {
    res.status(401).json({ message: "Invalid token" });
    return;
  }
  try {
    // Well-formed session claims only: positive-integer userId, and our `aud`
    // when present (legacy tokens predate it).
    const payload = parseSessionClaims(verified);
    if (!payload) {
      res.status(401).json({ message: "Invalid token" });
      return;
    }

    // Reject tokens issued before the user's last password change so that a
    // password reset invalidates all previously-issued sessions.
    const [user] = await db
      .select({
        passwordChangedAt: usersTable.passwordChangedAt,
        tokenVersion: usersTable.tokenVersion,
        emailVerifiedAt: usersTable.emailVerifiedAt,
      })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);
    if (!user) {
      res.status(401).json({ message: "Invalid token" });
      return;
    }
    // Defensive: sessions are only issued once the email is verified.
    if (!user.emailVerifiedAt) {
      res.status(401).json({ message: "Invalid token" });
      return;
    }
    // Revoked by a token_version bump ("sign out of all other devices", 2FA
    // change, password change/reset). Legacy tokens without `tv` count as 0.
    if (!isTokenVersionCurrent(payload, user.tokenVersion)) {
      res.status(401).json({ message: "Session expired. Please sign in again." });
      return;
    }
    // 5s grace: JWT `iat` is floored to whole seconds, so a token minted in the
    // same second as the reset must not be rejected. Stale tokens predate the
    // reset by far more than this and are still invalidated.
    if (
      user.passwordChangedAt &&
      payload.iat != null &&
      payload.iat * 1000 < user.passwordChangedAt.getTime() - 5000
    ) {
      res.status(401).json({ message: "Session expired. Please sign in again." });
      return;
    }

    req.userId = payload.userId;
    // Opportunistic "trial ending" email (no cron on autoscale). Throttled per
    // process and fire-and-forget — never delays or fails this request.
    maybeSendTrialReminder(payload.userId);
  } catch (err) {
    // A database failure is NOT an invalid session: answering 401 here would
    // make the app sign the user out over a transient outage.
    req.log?.error({ err }, "Auth lookup failed");
    res.status(503).json({ message: "Service temporarily unavailable" });
    return;
  }
  next();
}
