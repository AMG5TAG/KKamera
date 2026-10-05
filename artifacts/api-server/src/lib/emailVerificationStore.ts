import { db } from "@workspace/db";
import {
  usersTable, subscriptionsTable, referralsTable, trialHistoryTable, emailVerificationsTable,
} from "@workspace/db";
import { and, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { logger } from "./logger.js";
import { sendEmail, verificationCodeEmail, accountExistsEmail } from "./email.js";
import { emailTrialHashes } from "./emailHash.js";
import type { DbTx } from "./referrals.js";
import {
  VERIFICATION_CODE_TTL_MS, VERIFICATION_SEND_WINDOW_MS, VERIFICATION_ROW_RETENTION_MS,
  UNVERIFIED_ACCOUNT_RETENTION_MS, UNSENT_CODE_MARKER, NOTICE_CODE_MARKER,
  generateVerificationCode, generateVerificationNonce, hashVerificationNonce, hashVerificationCode,
  canSendVerificationCode, canSendAccountExistsNotice,
} from "./emailVerification.js";

// DB side of email verification (pure rules live in emailVerification.ts).
// Every write that issues a code runs under a row lock on the user, so
// concurrent requests for one account can't all pass the send throttle, and
// the housekeeping sweep (which locks the same rows) can't delete an account
// while a code is being issued for it.

export const TRIAL_DAYS = 14;

/**
 * Start the 14-day free trial for a user whose email has just been proven,
 * unless the account already has/had a subscription or trial, or the mailbox
 * already used its one trial. The trial_history row (keyed by an HMAC of the
 * email) outlives account deletion, so deleting and re-registering the same
 * address can't farm fresh trials; both the legacy key and the alias-normalised
 * one (+tags / Gmail dots) are checked and recorded. Returns true when granted.
 */
export async function grantTrialIfEligible(tx: DbTx, user: { id: number; email: string }): Promise<boolean> {
  // Every account gets a subscription row at registration; recreate defensively.
  await tx.insert(subscriptionsTable).values({ userId: user.id, status: "none" })
    .onConflictDoNothing({ target: subscriptionsTable.userId });
  const [sub] = await tx.select({
    id: subscriptionsTable.id, status: subscriptionsTable.status, trialStart: subscriptionsTable.trialStart,
  }).from(subscriptionsTable).where(eq(subscriptionsTable.userId, user.id)).for("update").limit(1);
  if (!sub || sub.status !== "none" || sub.trialStart) return false;

  const emailHashes = emailTrialHashes(user.email);
  const [priorTrial] = await tx.select({ id: trialHistoryTable.id })
    .from(trialHistoryTable).where(inArray(trialHistoryTable.emailHash, emailHashes)).limit(1);
  if (priorTrial) return false;

  const trialStart = new Date();
  const trialEnd = new Date(trialStart);
  trialEnd.setDate(trialEnd.getDate() + TRIAL_DAYS);
  await tx.update(subscriptionsTable)
    .set({ status: "trial", trialStart, trialEnd })
    .where(eq(subscriptionsTable.id, sub.id));
  await tx.insert(trialHistoryTable)
    .values(emailHashes.map((emailHash) => ({ emailHash })))
    .onConflictDoNothing();
  return true;
}

/** Void every unused code of a user (they're superseded or the account was proven another way). */
export async function invalidateUnusedVerifications(tx: DbTx, userId: number, now: Date): Promise<void> {
  await tx.update(emailVerificationsTable)
    .set({ usedAt: now })
    .where(and(eq(emailVerificationsTable.userId, userId), isNull(emailVerificationsTable.usedAt)));
}

export interface IssueVerificationInput {
  user: { id: number; email: string; name: string };
  /** Credentials of the registration that asked for this code (applied on verify); null for sign-in. */
  passwordHash?: string | null;
  name?: string | null;
}

/**
 * Create a verification row bound to a fresh nonce and email its code — unless
 * the per-account send throttle applies, in which case the row is still created
 * (so the client can call resend-verification with the nonce once the throttle
 * clears) but holds no redeemable code and nothing is emailed. Returns the
 * nonce either way; the caller's response must not reveal which happened.
 */
export async function issueVerificationCode(input: IssueVerificationInput): Promise<{ nonce: string; sent: boolean }> {
  const { user } = input;
  const nonce = generateVerificationNonce();
  const nonceHash = hashVerificationNonce(nonce);
  const now = new Date();

  const code = await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, user.id)).for("update");
    const recent = await tx.select({ createdAt: emailVerificationsTable.createdAt })
      .from(emailVerificationsTable)
      .where(and(
        eq(emailVerificationsTable.userId, user.id),
        gt(emailVerificationsTable.createdAt, new Date(now.getTime() - VERIFICATION_SEND_WINDOW_MS)),
        sql`${emailVerificationsTable.codeHash} LIKE 'h1:%'`,
      ));
    const canSend = canSendVerificationCode(recent.map(r => r.createdAt), now);
    const newCode = canSend ? generateVerificationCode() : null;
    // Only the newest emailed code works. A throttled (unsent) row leaves the
    // outstanding code alone so the person already holding it isn't stranded.
    if (newCode) await invalidateUnusedVerifications(tx, user.id, now);
    await tx.insert(emailVerificationsTable).values({
      userId: user.id,
      nonceHash,
      codeHash: newCode ? hashVerificationCode(nonceHash, newCode) : UNSENT_CODE_MARKER,
      passwordHash: input.passwordHash ?? null,
      name: input.name ?? null,
      expiresAt: new Date(now.getTime() + VERIFICATION_CODE_TTL_MS),
      createdAt: now,
    });
    return newCode;
  });

  if (code) {
    // Fire and forget — never block (or time-shape) the response on the provider.
    const mail = verificationCodeEmail(input.name ?? user.name, code);
    sendEmail({ to: user.email, ...mail }).catch(() => {});
  } else {
    logger.warn({ userId: user.id }, "Verification email suppressed (per-account limit)");
  }
  return { nonce, sent: code !== null };
}

/**
 * Tell the owner of an already-verified account that someone tried to register
 * their address (at most ACCOUNT_EXISTS_NOTICES_PER_WINDOW per hour). The notice
 * is recorded as a never-redeemable row carrying the dummy nonce returned to the
 * registering client, so the throttle holds across instances.
 */
export async function sendAccountExistsNotice(
  user: { id: number; email: string; name: string },
  dummyNonce: string,
): Promise<void> {
  const now = new Date();
  const allowed = await db.transaction(async (tx) => {
    await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, user.id)).for("update");
    const recent = await tx.select({ createdAt: emailVerificationsTable.createdAt })
      .from(emailVerificationsTable)
      .where(and(
        eq(emailVerificationsTable.userId, user.id),
        eq(emailVerificationsTable.codeHash, NOTICE_CODE_MARKER),
        gt(emailVerificationsTable.createdAt, new Date(now.getTime() - VERIFICATION_SEND_WINDOW_MS)),
      ));
    if (!canSendAccountExistsNotice(recent.map(r => r.createdAt), now)) return false;
    await tx.insert(emailVerificationsTable).values({
      userId: user.id,
      nonceHash: hashVerificationNonce(dummyNonce),
      codeHash: NOTICE_CODE_MARKER,
      expiresAt: now,
      usedAt: now,
      createdAt: now,
    });
    return true;
  });
  if (!allowed) return;
  const mail = accountExistsEmail(user.name);
  sendEmail({ to: user.email, ...mail }).catch(() => {});
}

// ─── Housekeeping ─────────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepAt = 0;

/**
 * Opportunistic cleanup (no cron on autoscale), at most once per interval per
 * process, fire-and-forget:
 *  - verification rows older than 24h are deleted (throttles only look back 1h);
 *  - never-verified accounts older than 30 days with no verification activity
 *    in that time and no subscription beyond "none" are deleted. Their
 *    subscription / verification / reset rows cascade; pending referral rows
 *    naming them (referred_id has no FK) are removed first. Unverified accounts
 *    can't sign in, so they own no clouds, uploads or feedback, and can't be a
 *    referrer (register only accepts verified referrers' codes).
 */
export function maybeSweepStaleVerifications(): void {
  const nowMs = Date.now();
  if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = nowMs;
  void sweepStaleVerifications(new Date(nowMs)).catch((err) => {
    logger.error({ err }, "Email verification sweep failed");
  });
}

async function sweepStaleVerifications(now: Date): Promise<void> {
  await db.delete(emailVerificationsTable)
    .where(lt(emailVerificationsTable.createdAt, new Date(now.getTime() - VERIFICATION_ROW_RETENTION_MS)));

  const cutoff = new Date(now.getTime() - UNVERIFIED_ACCOUNT_RETENTION_MS);
  const deleted = await db.transaction(async (tx) => {
    // SKIP LOCKED: an account someone is registering / verifying right now
    // (issueVerificationCode and verify lock the user row) is left alone.
    const stale = await tx.select({ id: usersTable.id }).from(usersTable)
      .where(and(
        isNull(usersTable.emailVerifiedAt),
        lt(usersTable.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM ${emailVerificationsTable} v WHERE v.user_id = ${usersTable.id} AND v.created_at >= ${cutoff})`,
        sql`NOT EXISTS (SELECT 1 FROM ${subscriptionsTable} s WHERE s.user_id = ${usersTable.id} AND s.status <> 'none')`,
      ))
      .for("update", { skipLocked: true })
      .limit(500);
    const ids = stale.map(u => u.id);
    if (ids.length === 0) return 0;
    await tx.delete(referralsTable)
      .where(and(inArray(referralsTable.referredId, ids), ne(referralsTable.status, "completed")));
    await tx.delete(usersTable).where(and(inArray(usersTable.id, ids), isNull(usersTable.emailVerifiedAt)));
    return ids.length;
  });
  if (deleted > 0) logger.info({ count: deleted }, "Deleted stale unverified accounts");
}
