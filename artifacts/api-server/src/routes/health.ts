import { Router, type IRouter, type RequestHandler } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// ─── Database state ───────────────────────────────────────────────────────────
// The server listens before its database check finishes, so readiness is
// tracked separately from liveness: /healthz is always 200, /readyz is 200 only
// once the required schema has been verified.

export type DatabaseState = "pending" | "ok" | "failed";
let databaseState: DatabaseState = "pending";

export function setDatabaseState(state: DatabaseState): void {
  databaseState = state;
}

export function getDatabaseState(): DatabaseState {
  return databaseState;
}

const UNGATED_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * Refuse API traffic until the read-only schema check passes. Health endpoints
 * remain available while the database is pending or failed. Mount under /api.
 */
export const requireVerifiedSchema: RequestHandler = (req, res, next) => {
  if (databaseState === "ok" || UNGATED_PATHS.has(req.path)) {
    next();
    return;
  }
  res.status(503).json({ message: "Service temporarily unavailable" });
};

// Liveness — the process is up and serving.
router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

// Readiness — database is reachable and required columns exist.
// Monitoring also probes the artifact's base path (/api).
router.get(["/", "/readyz"], (_req, res) => {
  const state = databaseState;
  res.status(state === "ok" ? 200 : 503).json({ status: state === "ok" ? "ok" : state });
});

export default router;
