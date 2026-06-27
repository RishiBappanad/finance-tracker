import { Router } from "express";
import { db } from "@workspace/db";
import { bankTransactions, accounts, receiptTransactionMatches } from "@workspace/db";
import { eq, and, gte, lte, like, isNull, sql } from "drizzle-orm";
import { ListTransactionsQueryParams } from "@workspace/api-zod";
import { getPlaidAdapter } from "../services/plaid.js";

const router = Router();

function serializeTxn(t: any, matchId?: number | null) {
  return {
    id: t.id,
    accountId: t.accountId,
    amount: t.amount,
    currency: t.currency,
    merchantName: t.merchantName ?? null,
    merchantNameRaw: t.merchantNameRaw ?? null,
    categoryPrimary: t.categoryPrimary ?? null,
    categoryDetail: t.categoryDetail ?? null,
    date: t.date,
    pending: t.pending,
    matchId: matchId ?? null,
    createdAt: t.createdAt?.toISOString?.() ?? t.createdAt ?? "",
  };
}

router.get("/unmatched", async (_req, res) => {
  const matched = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const rows = await db
    .select()
    .from(bankTransactions)
    .where(sql`${bankTransactions.id} NOT IN (${matched})`)
    .orderBy(bankTransactions.date);

  res.json(rows.map((r) => serializeTxn(r)));
});

router.get("/", async (req, res) => {
  const parsed = ListTransactionsQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [];
  if (params.accountId) conditions.push(eq(bankTransactions.accountId, params.accountId));
  if (params.pending != null) conditions.push(eq(bankTransactions.pending, params.pending));
  if (params.from) conditions.push(gte(bankTransactions.date, params.from));
  if (params.to) conditions.push(lte(bankTransactions.date, params.to));
  if (params.search)
    conditions.push(like(bankTransactions.merchantName, `%${params.search}%`));

  const rows = await db
    .select()
    .from(bankTransactions)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(bankTransactions.date);

  // Attach matchId from matches table
  const matchRows = await db
    .select({ txnId: receiptTransactionMatches.bankTransactionId, id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches);
  const matchMap = new Map(matchRows.map((m) => [m.txnId, m.id]));

  res.json(rows.map((r) => serializeTxn(r, matchMap.get(r.id))));
});

router.post("/sync", async (_req, res) => {
  const plaid = getPlaidAdapter();
  const allAccounts = await db.select().from(accounts);

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;

  for (const account of allAccounts) {
    try {
      const result = await plaid.syncTransactions("mock-access-token");
      for (const t of result.added) {
        await db
          .insert(bankTransactions)
          .values({
            id: t.transactionId,
            accountId: account.id,
            amount: t.amount,
            currency: t.isoCurrencyCode,
            merchantName: t.merchantName,
            merchantNameRaw: t.name,
            categoryPrimary: t.category[0] ?? null,
            categoryDetail: t.category[1] ?? null,
            date: t.date,
            pending: t.pending,
          })
          .onConflictDoNothing();
        totalAdded++;
      }
      totalModified += result.modified.length;
      totalRemoved += result.removed.length;
    } catch (_e) {
      // Per-account failures are non-fatal
    }
  }

  res.json({ added: totalAdded, removed: totalRemoved, updated: totalModified, accounts: allAccounts.length });
});

router.get("/:transactionId", async (req, res) => {
  const rows = await db
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, req.params.transactionId))
    .limit(1);

  if (!rows.length) return void res.status(404).json({ error: "Transaction not found" });

  const match = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.bankTransactionId, req.params.transactionId))
    .limit(1);

  res.json(serializeTxn(rows[0], match[0]?.id ?? null));
});

export default router;
