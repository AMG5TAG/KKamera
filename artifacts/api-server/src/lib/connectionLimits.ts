import { cloudConnectionsTable, usersTable } from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";
import type { DbTx } from "./referrals.js";
import { MAX_CONNECTIONS_PER_USER } from "./cloudUploadPolicy.js";

export const CONNECTION_LIMIT_MESSAGE =
  `You can connect at most ${MAX_CONNECTIONS_PER_USER} cloud accounts. Remove one in Settings to add another.`;

/**
 * Lock the user row and count their connections. Call inside the transaction
 * that adds one: the lock serialises concurrent creates/completions so the cap
 * (MAX_CONNECTIONS_PER_USER) can't be raced past. `confirmedOnly` leaves out
 * pending OAuth rows (which are short-lived and bounded separately).
 */
export async function connectionCountLocked(tx: DbTx, userId: number, opts: { confirmedOnly?: boolean } = {}): Promise<number> {
  await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, userId)).for("update");
  const [row] = await tx.select({ n: count() }).from(cloudConnectionsTable).where(and(
    eq(cloudConnectionsTable.userId, userId),
    opts.confirmedOnly ? isNull(cloudConnectionsTable.pendingNonceHash) : undefined,
  ));
  return row?.n ?? 0;
}
