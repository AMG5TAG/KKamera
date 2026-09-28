// "Your trial ends soon" email. Replit autoscale has no cron, so this is sent
// opportunistically on authenticated activity (see requireAuth) and can also be
// swept by an external scheduler via POST /api/internal/send-trial-reminders.
// Each user gets it at most once: the send is gated on an atomic claim of
// users.trial_reminder_sent_at.
import { db, usersTable, subscriptionsTable } from "@workspace/db";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { logger } from "./logger.js";
import { sendEmail, trialEndingEmail } from "./email.js";
import { isTrialReminderDue, trialDaysLeft, TRIAL_REMINDER_WINDOW_DAYS } from "./accountRules.js";

// Per-process throttle so the opportunistic check costs at most one small query
// per user every few hours, not one per request.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_TRACKED_USERS = 50_000;
const lastChecked = new Map<number, number>();

/**
 * Atomically claim the reminder for this user and send it. Returns true if this
 * call sent it. If the send fails the claim is released so a later check retries.
 */
async function claimAndSend(user: { id: number; email: string; name: string; trialEnd: Date }, now: Date): Promise<boolean> {
  const [claimed] = await db.update(usersTable)
    .set({ trialReminderSentAt: now })
    .where(and(eq(usersTable.id, user.id), isNull(usersTable.trialReminderSentAt)))
    .returning({ id: usersTable.id });
  if (!claimed) return false; // another request / instance already claimed it

  const sent = await sendEmail({ to: user.email, ...trialEndingEmail(user.name, trialDaysLeft(user.trialEnd, now)) });
  if (!sent) {
    await db.update(usersTable)
      .set({ trialReminderSentAt: null })
      .where(eq(usersTable.id, user.id));
    return false;
  }
  return true;
}

async function checkUser(userId: number): Promise<void> {
  const now = new Date();
  const [row] = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name,
    trialReminderSentAt: usersTable.trialReminderSentAt,
    status: subscriptionsTable.status, trialEnd: subscriptionsTable.trialEnd,
  })
    .from(usersTable)
    .innerJoin(subscriptionsTable, eq(subscriptionsTable.userId, usersTable.id))
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!row || !row.trialEnd || !isTrialReminderDue(row, now)) return;
  await claimAndSend({ id: row.id, email: row.email, name: row.name, trialEnd: row.trialEnd }, now);
}

/** Fire-and-forget: never blocks or fails the request that triggered it. */
export function maybeSendTrialReminder(userId: number): void {
  const nowMs = Date.now();
  const last = lastChecked.get(userId);
  if (last !== undefined && nowMs - last < CHECK_INTERVAL_MS) return;
  if (lastChecked.size >= MAX_TRACKED_USERS) lastChecked.clear();
  lastChecked.set(userId, nowMs);
  checkUser(userId).catch(err => logger.error({ err, userId }, "Trial reminder check failed"));
}

/** Send every due reminder (for an external scheduler). */
export async function sweepTrialReminders(limit = 500): Promise<{ due: number; sent: number }> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + TRIAL_REMINDER_WINDOW_DAYS * 86_400_000);
  const rows = await db.select({
    id: usersTable.id, email: usersTable.email, name: usersTable.name,
    trialEnd: subscriptionsTable.trialEnd,
  })
    .from(usersTable)
    .innerJoin(subscriptionsTable, eq(subscriptionsTable.userId, usersTable.id))
    .where(and(
      eq(subscriptionsTable.status, "trial"),
      isNull(usersTable.trialReminderSentAt),
      gt(subscriptionsTable.trialEnd, now),
      lte(subscriptionsTable.trialEnd, windowEnd),
    ))
    .limit(limit);

  let sent = 0;
  for (const row of rows) {
    if (!row.trialEnd) continue;
    try {
      if (await claimAndSend({ id: row.id, email: row.email, name: row.name, trialEnd: row.trialEnd }, now)) sent++;
    } catch (err) {
      logger.error({ err, userId: row.id }, "Trial reminder sweep: send failed");
    }
  }
  return { due: rows.length, sent };
}
