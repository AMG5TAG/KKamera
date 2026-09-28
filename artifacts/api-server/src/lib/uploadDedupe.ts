/**
 * Pure decision logic for de-duplicating /uploads/execute retries by the app's
 * per-capture `clientUploadId`. Kept free of DB/Express imports so it can be
 * unit-tested directly (no local imports: node --test runs the .ts sources).
 */

export const MAX_CLIENT_UPLOAD_ID_LENGTH = 100;
const CLIENT_UPLOAD_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * An "uploading" row older than this belongs to a request that died without
 * recording an outcome (process restart, crash). Every provider upload is
 * bounded by MAX_UPLOAD_DEADLINE_MS, so after that plus a margin the row can
 * safely be reclaimed by a retry.
 */
export const STALE_UPLOADING_MS = 20 * 60_000; // MAX_UPLOAD_DEADLINE_MS (15 min) + 5 min — test-enforced

export type ClientUploadIdField =
  | { ok: true; id: string | null }
  | { ok: false };

/** Absent/empty → null (no dedupe). Present → string ≤ 100 chars of [A-Za-z0-9_-]. */
export function parseClientUploadIdField(raw: unknown): ClientUploadIdField {
  if (raw === undefined || raw === null || raw === "") return { ok: true, id: null };
  if (typeof raw !== "string") return { ok: false };
  if (raw.length > MAX_CLIENT_UPLOAD_ID_LENGTH || !CLIENT_UPLOAD_ID_RE.test(raw)) return { ok: false };
  return { ok: true, id: raw };
}

export interface ExistingUploadSnapshot {
  status: string;
  updatedAt: Date;
}

export type ExistingUploadDecision =
  /** No row yet for this clientUploadId — insert one. */
  | { action: "insert" }
  /** Already fully uploaded — answer with the previous result, don't re-upload. */
  | { action: "done" }
  /** Another request is uploading this capture right now — 409, client retries later. */
  | { action: "busy" }
  /** A previous attempt ended (partial/failed/queued/pending) or went stale — reuse its row. */
  | { action: "reuse" };

export function decideExistingUpload(
  existing: ExistingUploadSnapshot | null | undefined,
  now: number = Date.now(),
): ExistingUploadDecision {
  if (!existing) return { action: "insert" };
  if (existing.status === "done") return { action: "done" };
  if (existing.status === "uploading" && !isStaleUploading(existing, now)) return { action: "busy" };
  return { action: "reuse" };
}

export function isStaleUploading(existing: ExistingUploadSnapshot, now: number = Date.now()): boolean {
  return now - existing.updatedAt.getTime() >= STALE_UPLOADING_MS;
}

/** Parse the stored CSV-of-ids connectionIds column. */
export function parseStoredConnectionIds(stored: string | null | undefined): number[] {
  if (!stored) return [];
  return stored.split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
}

export interface UploadAttemptResult {
  connectionId: number;
  success: boolean;
  error?: string;
}

export interface MergedUploadOutcome {
  status: "done" | "partial" | "failed";
  /** Every destination this capture has been sent to, as the stored CSV. */
  connectionIds: string;
  error: string | null;
}

/**
 * Combine this attempt's per-destination results with a previous attempt on
 * the same row. The app retries a partial upload with only the destinations
 * that failed, so destinations from a previous *partial* attempt that are not
 * part of this attempt already have the file:
 *  - every destination in this attempt succeeded → done
 *  - some succeeded now, or some succeeded before → partial
 *  - nothing has ever succeeded → failed
 */
export function mergeUploadOutcome(
  previous: { status: string; connectionIds: string | null } | null | undefined,
  results: UploadAttemptResult[],
): MergedUploadOutcome {
  const currentIds = results.map(r => r.connectionId);
  const allIds = [...new Set([...parseStoredConnectionIds(previous?.connectionIds), ...currentIds])];
  const allOk = results.length > 0 && results.every(r => r.success);
  const anyOk = results.some(r => r.success);
  const priorSuccess = previous?.status === "partial";
  const status = allOk ? "done" : anyOk || priorSuccess ? "partial" : "failed";
  const error = results.filter(r => !r.success).map(r => r.error).filter(Boolean).join("; ");
  return { status, connectionIds: allIds.join(","), error: error || null };
}

/** Postgres unique_violation, whether raw (pg) or wrapped by drizzle (err.cause). */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
