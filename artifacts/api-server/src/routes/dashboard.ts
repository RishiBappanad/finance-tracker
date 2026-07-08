import { Router } from "express";
import { db } from "@workspace/db";
import {
  scannedReceipts,
  bankTransactions,
  accounts,
  institutions,
  receiptTransactionMatches,
} from "@workspace/db";
import { gte, lte, and, sql, eq } from "drizzle-orm";

const router = Router();

router.get("/summary", async (req, res) => {
  const userId = req.user!.userId;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const twoWeeksStr = twoWeeks.toISOString().slice(0, 10);

  const [totalReceiptsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scannedReceipts)
    .where(eq(scannedReceipts.userId, userId));

  const [matchedReceiptsRow] = await db
    .select({ count: sql<number>`count(distinct ${receiptTransactionMatches.receiptId})::int` })
    .from(receiptTransactionMatches)
    .innerJoin(scannedReceipts, eq(receiptTransactionMatches.receiptId, scannedReceipts.id))
    .where(eq(scannedReceipts.userId, userId));

  const [totalTxnRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(institutions.userId, userId));

  const [spendRow] = await db
    .select({ total: sql<number>`coalesce(sum(${bankTransactions.amount}), 0)::float` })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(
      and(
        eq(institutions.userId, userId),
        gte(bankTransactions.date, monthStart),
        lte(bankTransactions.date, today),
        eq(bankTransactions.pending, false),
        sql`${bankTransactions.amount} > 0`
      )
    );

  const [expiringRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(scannedReceipts)
    .where(
      and(
        eq(scannedReceipts.userId, userId),
        sql`${scannedReceipts.returnDeadline} IS NOT NULL`,
        gte(scannedReceipts.returnDeadline, today),
        lte(scannedReceipts.returnDeadline, twoWeeksStr)
      )
    );

  const [pendingRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(receiptTransactionMatches)
    .innerJoin(scannedReceipts, eq(receiptTransactionMatches.receiptId, scannedReceipts.id))
    .where(
      and(
        eq(scannedReceipts.userId, userId),
        eq(receiptTransactionMatches.confirmed, false)
      )
    );

  const totalReceipts = totalReceiptsRow?.count ?? 0;
  const matchedReceipts = matchedReceiptsRow?.count ?? 0;

  res.json({
    totalReceipts,
    matchedReceipts,
    unmatchedReceipts: totalReceipts - matchedReceipts,
    totalTransactions: totalTxnRow?.count ?? 0,
    expiringReturns: expiringRow?.count ?? 0,
    totalSpendThisMonth: spendRow?.total ?? 0,
    pendingReconciliation: pendingRow?.count ?? 0,
  });
});

// GET /dashboard/spending-over-time
// Returns daily or cumulative spending by category over a date range
router.get("/spending-over-time", async (req, res) => {
  const userId = req.user!.userId;
  const { from, to, cumulative } = req.query as {
    from?: string;
    to?: string;
    cumulative?: string;
  };

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  const fromDate = from ?? monthAgo.toISOString().slice(0, 10);
  const toDate = to ?? today;

  // Get daily spending per category
  const rows = await db
    .select({
      date: bankTransactions.date,
      category: bankTransactions.userCategory,
      total: sql<number>`SUM(${bankTransactions.amount})`,
    })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(
      and(
        eq(institutions.userId, userId),
        sql`${bankTransactions.userCategory} IS NOT NULL`,
        sql`${bankTransactions.amount} > 0`,
        eq(bankTransactions.ignored, false),
        gte(bankTransactions.date, fromDate),
        lte(bankTransactions.date, toDate)
      )
    )
    .groupBy(bankTransactions.date, bankTransactions.userCategory)
    .orderBy(bankTransactions.date);

  if (cumulative !== "true") {
    res.json(rows.map((r) => ({
      date: r.date,
      category: r.category ?? "Other",
      total: Number(r.total) || 0,
    })));
    return;
  }

  // Build cumulative totals per category
  const cumTotals: Record<string, number> = {};
  const result = rows.map((r) => {
    const cat = r.category ?? "Other";
    cumTotals[cat] = (cumTotals[cat] ?? 0) + (Number(r.total) || 0);
    return { date: r.date, category: cat, total: cumTotals[cat] };
  });

  res.json(result);
});

export default router;
