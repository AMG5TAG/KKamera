// Give an existing KKamera account premium (upload) access without a store
// purchase — for staff / owner accounts. Run where DATABASE_URL points at the
// target database (e.g. the Replit shell for production):
//
//   pnpm --filter @workspace/scripts run grant-premium -- someone@example.com
//   pnpm --filter @workspace/scripts run grant-premium -- someone@example.com --until 2030-01-01
//   pnpm --filter @workspace/scripts run grant-premium -- someone@example.com --dry-run
//
// It sets the subscription to "active" until --until (default 2099-12-31).
// RevenueCat sync leaves a non-store grant alone (no entitlement = no change),
// and last_event_at is stamped so an older store webhook can't downgrade it.
// The account must already exist (register in the app first).
import { db, pool, usersTable, subscriptionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

function usage(message?: string): never {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: grant-premium <email> [--until YYYY-MM-DD] [--dry-run]");
  process.exit(1);
}

function parseArgs(argv: string[]) {
  let email: string | undefined;
  let until = new Date("2099-12-31T23:59:59Z");
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--until") {
      const value = argv[++i];
      const date = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59Z`) : null;
      if (!date || Number.isNaN(date.getTime())) usage("--until needs a date like 2030-01-01");
      until = date;
    } else if (arg.startsWith("--")) usage(`unknown option ${arg}`);
    else if (!email) email = arg.trim().toLowerCase();
    else usage("only one email may be given");
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) usage("a valid email address is required");
  if (until <= new Date()) usage("--until must be in the future");
  return { email, until, dryRun };
}

async function main() {
  // pnpm forwards the "--" separator itself; it isn't an argument.
  const { email, until, dryRun } = parseArgs(process.argv.slice(2).filter(a => a !== "--"));

  // Emails are stored lower-cased at sign-up; match case-insensitively anyway.
  const [user] = await db.select({ id: usersTable.id, email: usersTable.email, verifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(sql`lower(${usersTable.email})`, email))
    .limit(1);
  if (!user) {
    console.error(`No account for ${email}. Register in the app first, then rerun.`);
    process.exitCode = 1;
    return;
  }
  if (!user.verifiedAt) {
    console.warn(`Note: ${user.email} hasn't verified its email yet; it can't sign in until it does.`);
  }

  const [before] = await db.select().from(subscriptionsTable).where(eq(subscriptionsTable.userId, user.id)).limit(1);
  console.log(`Account: ${user.email} (id ${user.id})`);
  console.log(`Before:  ${before ? `${before.status}, period end ${before.currentPeriodEnd?.toISOString() ?? "none"}` : "no subscription row"}`);
  console.log(`After:   active, period end ${until.toISOString()}`);
  if (dryRun) {
    console.log("Dry run — nothing changed.");
    return;
  }

  const now = new Date();
  await db.insert(subscriptionsTable)
    .values({ userId: user.id, status: "active", currentPeriodEnd: until, lastEventAt: now })
    .onConflictDoUpdate({
      target: subscriptionsTable.userId,
      set: { status: "active", currentPeriodEnd: until, lastEventAt: now },
    });
  console.log("Done. Reopen the app (or pull to refresh Subscription) to see it.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
