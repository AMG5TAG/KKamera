import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

declare global {
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

// Validated at startup in index.ts — guaranteed to be set
export const JWT_SECRET = process.env["SESSION_SECRET"]!;

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number; iat?: number };

    // Reject tokens issued before the user's last password change so that a
    // password reset invalidates all previously-issued sessions.
    const [user] = await db
      .select({ passwordChangedAt: usersTable.passwordChangedAt })
      .from(usersTable)
      .where(eq(usersTable.id, payload.userId))
      .limit(1);
    if (!user) {
      res.status(401).json({ message: "Invalid token" });
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
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}
