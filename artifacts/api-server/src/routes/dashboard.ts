import { Router } from "express";
import { db } from "@workspace/db";
import {
  scannedReceipts,
  bankTransactions,
  receiptTransactionMatches,
} from "@workspace/db";
import { gte, lte, and, sql, eq } from "drizzle-orm";
import { GetSpendingByCategoryQueryParams } from "@workspace/api-zod";

const router = Router();

router.get("/summary", async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const twoWeeksStr = twoWeeks.toISOString().slice(0, 10);

  const [totalReceiptsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scannedReceipts);

  const [matchedReceiptsRow] = await db
    .select({ count: sql<number>`count(distinct ${receiptTransactionMatches.receiptId})::int` })
    .from(receiptTransactionMatches);

  const [totalTxnRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions);

  const [unmatchedTxnRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .where(
      sql`${bankTransactions.id} NOT IN (SELECT bank_transaction_id FROM receipt_transaction_matches)`
    );

  const [expiringRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scannedReceipts)
    .where(
      and(
        sql`${scannedReceipts.returnDeadline} IS NOT NULL`,
        gte(scannedReceipts.returnDeadline, today),
        lte(scannedReceipts.returnDeadline, twoWeeksStr)
      )
    );

  const [spendRow] = await db
    .select({ total: sql<number>`coalesce(sum(${bankTransactions.amount}), 0)::float` })
    .from(bankTransactions)
    .where(
      and(
        gte(bankTransactions.date, monthStart),
        lte(bankTransactions.date, today),
        eq(bankTransactions.pending, false)
      )
    );

  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.confirmed, false));

  const totalReceipts = totalReceiptsRow?.count ?? 0;
  const matchedReceipts = matchedReceiptsRow?.count ?? 0;

  res.json({
    totalReceipts,
    matchedReceipts,
    unmatchedReceipts: totalReceipts - matchedReceipts,
    totalTransactions: totalTxnRow?.count ?? 0,
    unmatchedTransactions: unmatchedTxnRow?.count ?? 0,
    expiringReturns: expiringRow?.count ?? 0,
    totalSpendThisMonth: spendRow?.total ?? 0,
    pendingReconciliation: pendingRow?.count ?? 0,
  });
});

router.get("/spending-by-category", async (req, res) => {
  const parsed = GetSpendingByCategoryQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [];
  if (params.from) conditions.push(gte(bankTransactions.date, params.from));
  if (params.to) conditions.push(lte(bankTransactions.date, params.to));

  const rows = await db
    .select({
      category: sql<string>`coalesce(${bankTransactions.categoryPrimary}, 'Uncategorized')`,
      total: sql<number>`sum(${bankTransactions.amount})::float`,
      count: sql<number>`count(*)::int`,
    })
    .from(bankTransactions)
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(sql`coalesce(${bankTransactions.categoryPrimary}, 'Uncategorized')`)
    .orderBy(sql`sum(${bankTransactions.amount}) desc`);

  res.json(rows);
});

export default router;
