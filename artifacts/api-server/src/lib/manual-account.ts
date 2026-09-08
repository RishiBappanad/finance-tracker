/**
 * Every bank_transactions row needs an accountId (NOT NULL, references a
 * real Plaid-linked account) -- but the Event Contract's POST /events/log
 * needed a way to log a transaction with no Plaid account behind it at
 * all. Rather than loosen that constraint (which would touch every
 * ownership query in this codebase, all of which join
 * bank_transactions -> accounts -> institutions.userId to find the
 * owning user), this lazily creates one synthetic "Manual Entries"
 * institution + account per user on first use. A manually-logged
 * transaction is then a completely normal bank_transactions row --
 * same ownership join, same list/aggregation endpoints, no special
 * casing anywhere else in the codebase.
 */
import { db } from "@workspace/db";
import { accounts, institutions } from "@workspace/db";
import { eq } from "drizzle-orm";

const MANUAL_INSTITUTION_NAME = "Manual Entries";

function manualAccountId(userId: number): string {
  return `manual-${userId}`;
}

export async function getOrCreateManualAccountId(userId: number): Promise<string> {
  const id = manualAccountId(userId);

  const existing = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, id)).limit(1);
  if (existing.length > 0) return id;

  // institutions.plaidAccessToken/plaidItemId stay null -- this
  // institution was never actually linked via Plaid, and nothing reads
  // those columns without first checking they're non-null (see
  // routes/transactions.ts's POST /sync, which skips institutions with
  // no plaidAccessToken).
  await db
    .insert(institutions)
    .values({ id, name: MANUAL_INSTITUTION_NAME, userId })
    .onConflictDoNothing();

  await db
    .insert(accounts)
    .values({ id, institutionId: id, name: MANUAL_INSTITUTION_NAME, type: "manual", currency: "USD" })
    .onConflictDoNothing();

  return id;
}
