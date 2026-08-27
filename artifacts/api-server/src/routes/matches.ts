import { Router } from "express";
import { db } from "@workspace/db";
import {
  receiptTransactionMatches,
  scannedReceipts,
  bankTransactions,
  accounts,
  institutions,
} from "@workspace/db";
import { eq, and, isNull, sql } from "drizzle-orm";
import { CreateMatchBody, UpdateMatchBody, ListMatchesQueryParams } from "@workspace/api-zod";
import { reconcile, ReceiptCandidate, TransactionCandidate } from "../services/reconciler.js";

const router = Router();

function serializeMatch(m: any) {
  return {
    id: m.id,
    receiptId: m.receiptId,
    bankTransactionId: m.bankTransactionId,
    matchMethod: m.matchMethod,
    confidenceScore: m.confidenceScore ?? null,
    scoreBreakdown: m.scoreBreakdown ? JSON.parse(m.scoreBreakdown) : null,
    confirmed: m.confirmed,
    confirmedAt: m.confirmedAt?.toISOString?.() ?? m.confirmedAt ?? null,
    createdAt: m.createdAt?.toISOString?.() ?? m.createdAt ?? "",
  };
}

// POST /reconcile — run auto-reconciliation for the current user's own
// receipts and transactions only. (Previously this queried unmatched
// receipts/transactions with no user filter at all — any user's receipt
// could have been auto-matched against another user's bank transaction.
// Fixed alongside wiring auto-match into POST /receipts/confirm, since
// both paths needed the same user-scoped transaction lookup.)
router.post("/run", async (req, res) => {
  const userId = req.user!.userId;

  // Get this user's unmatched receipts
  const matchedReceiptIds = db
    .select({ id: receiptTransactionMatches.receiptId })
    .from(receiptTransactionMatches);

  const unmatchedReceipts = await db
    .select()
    .from(scannedReceipts)
    .where(
      and(
        eq(scannedReceipts.userId, userId),
        sql`${scannedReceipts.id} NOT IN (${matchedReceiptIds})`
      )
    );

  // Get this user's unmatched transactions
  const matchedTxnIds = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const unmatchedTxns = await db
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

  const txnCandidates: TransactionCandidate[] = unmatchedTxns.map((t) => ({
    id: t.id,
    amount: t.amount,
    date: t.date,
    merchantName: t.merchantName ?? t.merchantNameRaw ?? null,
  }));

  let autoMatched = 0;
  let needsReview = 0;
  let unmatched = 0;
  const createdMatches: any[] = [];

  for (const receipt of unmatchedReceipts) {
    if (!receipt.total || !receipt.purchaseDate) {
      unmatched++;
      continue;
    }

    const candidate: ReceiptCandidate = {
      id: receipt.id,
      total: receipt.total,
      purchaseDate: receipt.purchaseDate,
      storeName: receipt.storeName ?? null,
    };

    const outcome = reconcile(candidate, txnCandidates);

    if (outcome.status === "auto_matched" && outcome.best) {
      const [match] = await db
        .insert(receiptTransactionMatches)
        .values({
          receiptId: receipt.id,
          bankTransactionId: outcome.best.transaction.id,
          matchMethod: "auto",
          confidenceScore: outcome.best.composite,
          scoreBreakdown: JSON.stringify(outcome.best.breakdown),
          confirmed: false,
        })
        .onConflictDoNothing()
        .returning();
      if (match) createdMatches.push(match);
      autoMatched++;
      // Remove from candidate pool so it can't double-match
      const idx = txnCandidates.findIndex((t) => t.id === outcome.best!.transaction.id);
      if (idx !== -1) txnCandidates.splice(idx, 1);
    } else if (outcome.status === "needs_review") {
      needsReview++;
    } else {
      unmatched++;
    }
  }

  res.json({
    autoMatched,
    needsReview,
    unmatched,
    matches: createdMatches.map(serializeMatch),
  });
});

// A match has no userId column of its own -- ownership flows through its
// receipt (which does have one), same pattern dashboard.ts's /summary
// already uses (innerJoin receiptTransactionMatches -> scannedReceipts,
// filter by scannedReceipts.userId) to count "my pending matches".
async function matchBelongsToUser(matchId: number, userId: number): Promise<boolean> {
  const rows = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .innerJoin(scannedReceipts, eq(receiptTransactionMatches.receiptId, scannedReceipts.id))
    .where(and(eq(receiptTransactionMatches.id, matchId), eq(scannedReceipts.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// SECURITY FIX (2026-08-27): no user filter -- returned every user's
// matches to any authenticated caller.
router.get("/", async (req, res) => {
  const parsed = ListMatchesQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [eq(scannedReceipts.userId, req.user!.userId)];
  if (params.confirmed != null) conditions.push(eq(receiptTransactionMatches.confirmed, params.confirmed));

  const rows = await db
    .select({
      id: receiptTransactionMatches.id,
      receiptId: receiptTransactionMatches.receiptId,
      bankTransactionId: receiptTransactionMatches.bankTransactionId,
      matchMethod: receiptTransactionMatches.matchMethod,
      confidenceScore: receiptTransactionMatches.confidenceScore,
      scoreBreakdown: receiptTransactionMatches.scoreBreakdown,
      confirmed: receiptTransactionMatches.confirmed,
      confirmedAt: receiptTransactionMatches.confirmedAt,
      createdAt: receiptTransactionMatches.createdAt,
    })
    .from(receiptTransactionMatches)
    .innerJoin(scannedReceipts, eq(receiptTransactionMatches.receiptId, scannedReceipts.id))
    .where(and(...conditions))
    .orderBy(receiptTransactionMatches.createdAt);

  res.json(rows.map(serializeMatch));
});

// SECURITY FIX (2026-08-27): no ownership validation on either side of
// the match -- a user could link their own receipt to someone ELSE's
// bank transaction (or vice versa), splicing another user's financial
// data into their own reconciliation view. Both must belong to the
// caller before a manual match is allowed.
router.post("/", async (req, res) => {
  const parsed = CreateMatchBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const userId = req.user!.userId;
  const [receiptOwned] = await db
    .select({ id: scannedReceipts.id })
    .from(scannedReceipts)
    .where(and(eq(scannedReceipts.id, parsed.data.receiptId), eq(scannedReceipts.userId, userId)))
    .limit(1);
  if (!receiptOwned) return void res.status(404).json({ error: "Receipt not found" });

  const [txnOwned] = await db
    .select({ id: bankTransactions.id })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(eq(bankTransactions.id, parsed.data.bankTransactionId), eq(institutions.userId, userId)))
    .limit(1);
  if (!txnOwned) return void res.status(404).json({ error: "Transaction not found" });

  const [match] = await db
    .insert(receiptTransactionMatches)
    .values({ ...parsed.data, matchMethod: "manual", confirmed: true, confirmedAt: new Date() })
    .returning();

  res.status(201).json(serializeMatch(match));
});

// SECURITY FIX (2026-08-27): no ownership check -- any authenticated
// user could confirm/unconfirm any other user's match.
router.patch("/:matchId", async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!(await matchBelongsToUser(matchId, req.user!.userId))) {
    return void res.status(404).json({ error: "Match not found" });
  }

  const parsed = UpdateMatchBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const updates: Record<string, any> = {};
  if (parsed.data.confirmed != null) {
    updates.confirmed = parsed.data.confirmed;
    updates.confirmedAt = parsed.data.confirmed ? new Date() : null;
  }

  const [row] = await db
    .update(receiptTransactionMatches)
    .set(updates)
    .where(eq(receiptTransactionMatches.id, matchId))
    .returning();

  if (!row) return void res.status(404).json({ error: "Match not found" });
  res.json(serializeMatch(row));
});

// SECURITY FIX (2026-08-27): no ownership check -- any authenticated
// user could delete any other user's match.
router.delete("/:matchId", async (req, res) => {
  const matchId = Number(req.params.matchId);
  if (!(await matchBelongsToUser(matchId, req.user!.userId))) {
    return void res.status(404).json({ error: "Match not found" });
  }

  await db
    .delete(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.id, matchId));
  res.status(204).send();
});

export default router;
