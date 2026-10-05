import { Router, type IRouter, type RequestHandler } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

// ─── Migration state ──────────────────────────────────────────────────────────
// The server listens before migrations finish (see index.ts), so readiness is
// tracked separately from liveness: /healthz is always 200, /readyz is 200 only
// once the schema is current.

export type MigrationState = "pending" | "ok" | "failed";
let migrationState: MigrationState = "pending";

export function setMigrationState(state: MigrationState): void {
  migrationState = state;
}

export function getMigrationState(): MigrationState {
  return migrationState;
}

const UNGATED_PATHS = new Set(["/healthz", "/readyz"]);

/**
 * After a DEFINITIVE migration failure, refuse API traffic with 503 rather than
 * serving on a stale schema. While migrations are still pending (first seconds
 * after boot) requests pass through as usual. Mount under /api.
 */
export const requireMigratedSchema: RequestHandler = (req, res, next) => {
  if (migrationState !== "failed" || UNGATED_PATHS.has(req.path)) {
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

// Readiness — database migrations have been applied.
router.get("/readyz", (_req, res) => {
  const state = migrationState;
  res.status(state === "ok" ? 200 : 503).json({ status: state === "ok" ? "ok" : state });
});

export default router;
