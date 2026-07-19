/**
 * Shared reconciliation helper — runs the fuzzy-matching engine
 * (services/reconciler.ts) against one specific receipt, scoped to the
 * owning user's own bank transactions, and persists an auto_matched result
 * as a real match row.
 *
 * Used by:
 *  - routes/receipts.ts's POST /confirm — as soon as Gemini's extraction is
 *    saved as a real receipt, immediately try to match it (or surface
 *    suggestions) instead of requiring a separate manual trip to the
 *    Reconcile page.
 *  - routes/matches.ts's POST /reconcile/run — the bulk "match everything
 *    unmatched" action, refactored to call this per-receipt instead of
 *    duplicating the single-receipt logic inline.
 */
import { db } from "@workspace/db";
import {
  receiptTransactionMatches,
  bankTransactions,
  accounts,
  institutions,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { reconcile, type ReceiptCandidate, type TransactionCandidate, type ReconcileOutcome } from "./reconciler.js";

export interface ReceiptMatchResult {
  outcome: ReconcileOutcome;
  /** Present only when a match row was actually created (status === "auto_matched"). */
  createdMatch?: {
    id: number;
    receiptId: number;
    bankTransactionId: string;
    matchMethod: string;
    confidenceScore: number | null;
    scoreBreakdown: string | null;
    confirmed: boolean;
  };
}

/**
 * Find unmatched bank transactions belonging to `userId`, excluding any
 * transaction ids already claimed by a match (so this receipt can't be
 * suggested a transaction another receipt already owns).
 */
async function getUnmatchedTransactionsForUser(userId: number): Promise<TransactionCandidate[]> {
  const matchedTxnIds = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const rows = await db
    .select({
      id: bankTransactions.id,
      amount: bankTransactions.amount,
      date: bankTransactions.date,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
    })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(
      and(
        eq(institutions.userId, userId),
        sql`${bankTransactions.id} NOT IN (${matchedTxnIds})`
      )
    );

  return rows.map((t) => ({
    id: t.id,
    amount: t.amount,
    date: t.date,
    merchantName: t.merchantName ?? t.merchantNameRaw ?? null,
  }));
}

/**
 * Compute match candidates for a receipt against its owner's unmatched
 * transactions. Never writes to the database — callers decide whether to
 * persist an auto_matched result (see persistAutoMatch below).
 */
export async function computeReceiptMatch(
  receipt: ReceiptCandidate,
  userId: number
): Promise<ReconcileOutcome> {
  const candidates = await getUnmatchedTransactionsForUser(userId);
  return reconcile(receipt, candidates);
}

/**
 * Persist an auto_matched outcome as a real match row. No-op (returns
 * undefined) if the outcome isn't auto_matched.
 */
export async function persistAutoMatch(outcome: ReconcileOutcome): Promise<ReceiptMatchResult["createdMatch"]> {
  if (outcome.status !== "auto_matched" || !outcome.best) return undefined;

  const [match] = await db
    .insert(receiptTransactionMatches)
    .values({
      receiptId: outcome.receiptId,
      bankTransactionId: outcome.best.transaction.id,
      matchMethod: "auto",
      confidenceScore: outcome.best.composite,
      scoreBreakdown: JSON.stringify(outcome.best.breakdown),
      confirmed: false,
    })
    .onConflictDoNothing()
    .returning();

  return match;
}

/**
 * Convenience wrapper: compute + persist in one call. Used by callers that
 * always want an auto_matched result saved immediately (e.g. right after
 * confirming a newly-scanned receipt). Callers that need read-only
 * suggestions (e.g. browsing an existing unmatched receipt) should use
 * computeReceiptMatch directly instead.
 */
export async function reconcileOneReceipt(
  receipt: ReceiptCandidate,
  userId: number
): Promise<ReceiptMatchResult> {
  const outcome = await computeReceiptMatch(receipt, userId);
  const createdMatch = await persistAutoMatch(outcome);
  return { outcome, createdMatch };
}
