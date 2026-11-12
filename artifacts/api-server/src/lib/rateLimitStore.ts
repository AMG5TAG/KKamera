import { createHash } from "crypto";
import rateLimit, { MemoryStore, type Options, type Store, type ClientRateLimitInfo } from "express-rate-limit";
import { db, rateLimitHitsTable } from "@workspace/db";
import { eq, lt, sql } from "drizzle-orm";
import { logger } from "./logger.js";

/**
 * Postgres-backed express-rate-limit store, so limits hold across autoscale
 * instances and restarts (the default MemoryStore is per process: N instances
 * meant N× the limit). Fixed windows, one row per key in rate_limit_hits, and
 * one atomic upsert per hit (the window resets in the same statement once
 * reset_at has passed). Expired rows are swept every few minutes.
 *
 * Availability over strictness: if the database errors, the store falls back
 * to a per-process MemoryStore for that call (logged, throttled) rather than
 * failing the request.
 */

/** Longest stored key; longer ones are hashed (keys are limiter prefix + user id / IP). */
const MAX_KEY_LENGTH = 200;

/** `prefix:key`, hashed when it would exceed MAX_KEY_LENGTH so the PK stays bounded. */
export function rateLimitKey(prefix: string, key: string): string {
  const full = `${prefix}:${key}`;
  if (full.length <= MAX_KEY_LENGTH) return full;
  return `${prefix}:h:${createHash("sha256").update(key).digest("hex")}`;
}

function upsertHitSql(key: string, windowMs: number) {
  return sql`
    INSERT INTO ${rateLimitHitsTable} (key, hits, reset_at)
    VALUES (${key}, 1, now() + make_interval(secs => ${windowMs / 1000}))
    ON CONFLICT (key) DO UPDATE SET
      hits = CASE WHEN ${rateLimitHitsTable.resetAt} <= now() THEN 1 ELSE ${rateLimitHitsTable.hits} + 1 END,
      reset_at = CASE WHEN ${rateLimitHitsTable.resetAt} <= now() THEN EXCLUDED.reset_at ELSE ${rateLimitHitsTable.resetAt} END
    RETURNING hits, reset_at`;
}

/** Count one hit against `key` (fixed window of `windowMs`). Throws on DB error. */
export async function hitCounter(key: string, windowMs: number): Promise<ClientRateLimitInfo> {
  const res = await db.execute<{ hits: number; reset_at: Date | string }>(upsertHitSql(key, windowMs));
  const row = res.rows[0];
  if (!row) throw new Error("rate limit upsert returned no row");
  return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
}

/**
 * In ONE round trip: count a hit against `hitKey` (atomically, like hitCounter)
 * and read the live hit count of `peekKey` (0 when none / expired; skipped when
 * null). Throws on DB error.
 */
export async function hitAndPeekCounters(
  hitKey: string,
  windowMs: number,
  peekKey: string | null,
): Promise<{ hits: number; peeked: number }> {
  const res = await db.execute<{ hits: number; peeked: number | null }>(sql`
    WITH h AS (${upsertHitSql(hitKey, windowMs)})
    SELECT (SELECT hits FROM h) AS hits,
      (SELECT ${rateLimitHitsTable.hits} FROM ${rateLimitHitsTable}
        WHERE ${rateLimitHitsTable.key} = ${peekKey ?? ""} AND ${rateLimitHitsTable.resetAt} > now()) AS peeked`);
  const row = res.rows[0];
  if (!row || row.hits == null) throw new Error("rate limit upsert returned no row");
  return { hits: Number(row.hits), peeked: peekKey ? Number(row.peeked ?? 0) : 0 };
}

/** Take one hit back off `key`, and forget `clearKey` entirely — one round trip. Throws on DB error. */
export async function releaseCounters(key: string, clearKey: string | null): Promise<void> {
  await db.execute(sql`
    WITH d AS (DELETE FROM ${rateLimitHitsTable} WHERE ${rateLimitHitsTable.key} = ${clearKey ?? ""})
    UPDATE ${rateLimitHitsTable} SET hits = GREATEST(${rateLimitHitsTable.hits} - 1, 0)
    WHERE ${rateLimitHitsTable.key} = ${key}`);
}

/** Forget `key` entirely. Throws on DB error. */
export async function clearCounter(key: string): Promise<void> {
  await db.delete(rateLimitHitsTable).where(eq(rateLimitHitsTable.key, key));
}

// ─── Housekeeping ─────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 5 * 60_000;
let sweepTimer: NodeJS.Timeout | null = null;

function startSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    db.delete(rateLimitHitsTable).where(lt(rateLimitHitsTable.resetAt, sql`now() - interval '1 minute'`))
      .catch((err) => logger.warn({ err }, "Rate-limit sweep failed"));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

// Log DB failures at most once a minute per process (a DB outage would
// otherwise log on every request).
let lastFallbackLog = 0;
function logFallback(err: unknown, op: string): void {
  const now = Date.now();
  if (now - lastFallbackLog < 60_000) return;
  lastFallbackLog = now;
  logger.error({ err, op }, "Rate-limit store DB error — falling back to in-memory limits");
}

// ─── Store ────────────────────────────────────────────────────────────────────

export class PostgresRateLimitStore implements Store {
  readonly prefix: string;
  readonly localKeys = false;
  private windowMs = 60_000;
  private readonly memory = new MemoryStore();

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.memory.init(options);
    startSweeper();
  }

  async get(key: string): Promise<ClientRateLimitInfo | undefined> {
    try {
      const [row] = await db.select().from(rateLimitHitsTable)
        .where(sql`${rateLimitHitsTable.key} = ${rateLimitKey(this.prefix, key)} AND ${rateLimitHitsTable.resetAt} > now()`)
        .limit(1);
      return row ? { totalHits: row.hits, resetTime: row.resetAt } : undefined;
    } catch (err) {
      logFallback(err, "get");
      return this.memory.get(key);
    }
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      return await hitCounter(rateLimitKey(this.prefix, key), this.windowMs);
    } catch (err) {
      logFallback(err, "increment");
      return this.memory.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await db.update(rateLimitHitsTable)
        .set({ hits: sql`GREATEST(${rateLimitHitsTable.hits} - 1, 0)` })
        .where(eq(rateLimitHitsTable.key, rateLimitKey(this.prefix, key)));
    } catch (err) {
      logFallback(err, "decrement");
      await this.memory.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    await this.memory.resetKey(key);
    try {
      await clearCounter(rateLimitKey(this.prefix, key));
    } catch (err) {
      logFallback(err, "resetKey");
    }
  }

  shutdown(): void {
    this.memory.shutdown();
  }
}

const usedNames = new Set<string>();

function claimName(name: string): void {
  if (usedNames.has(name)) throw new Error(`Duplicate rate limiter name: ${name}`);
  usedNames.add(name);
}

/**
 * express-rate-limit with the shared Postgres store (one DB round trip per
 * request). For security-critical limiters only — credential guessing, account
 * changes, outbound email/invites, abuse-prone writes — where N autoscale
 * instances must not mean N× the limit. `name` namespaces the keys and must be
 * unique per limiter (two limiters sharing one would share counts).
 */
export function sharedRateLimit(name: string, options: Partial<Options>) {
  claimName(name);
  return rateLimit({ ...options, store: new PostgresRateLimitStore(name) });
}

/**
 * express-rate-limit with the default per-process memory store: no DB round
 * trip, for hot paths (uploads, subscription sync, connection tests) whose
 * limits are about load rather than security, so a per-instance limit is fine.
 */
export function localRateLimit(name: string, options: Partial<Options>) {
  claimName(name);
  return rateLimit(options);
}
