import { Router } from "express";
import { db } from "@workspace/db";
import {
  receiptTransactionMatches,
  scannedReceipts,
  bankTransactions,
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

// POST /reconcile — run auto-reconciliation
router.post("/run", async (_req, res) => {
  // Get all unmatched receipts
  const matchedReceiptIds = db
    .select({ id: receiptTransactionMatches.receiptId })
    .from(receiptTransactionMatches);

  const unmatchedReceipts = await db
    .select()
    .from(scannedReceipts)
    .where(sql`${scannedReceipts.id} NOT IN (${matchedReceiptIds})`);

  // Get all unmatched transactions
  const matchedTxnIds = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const unmatchedTxns = await db
    .select()
    .from(bankTransactions)
    .where(sql`${bankTransactions.id} NOT IN (${matchedTxnIds})`);

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

router.get("/", async (req, res) => {
  const parsed = ListMatchesQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [];
  if (params.confirmed != null) conditions.push(eq(receiptTransactionMatches.confirmed, params.confirmed));

  const rows = await db
    .select()
    .from(receiptTransactionMatches)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(receiptTransactionMatches.createdAt);

  res.json(rows.map(serializeMatch));
});

router.post("/", async (req, res) => {
  const parsed = CreateMatchBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const [match] = await db
    .insert(receiptTransactionMatches)
    .values({ ...parsed.data, matchMethod: "manual", confirmed: true, confirmedAt: new Date() })
    .returning();

  res.status(201).json(serializeMatch(match));
});

router.patch("/:matchId", async (req, res) => {
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
    .where(eq(receiptTransactionMatches.id, Number(req.params.matchId)))
    .returning();

  if (!row) return void res.status(404).json({ error: "Match not found" });
  res.json(serializeMatch(row));
});

router.delete("/:matchId", async (req, res) => {
  await db
    .delete(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.id, Number(req.params.matchId)));
  res.status(204).send();
});

export default router;
