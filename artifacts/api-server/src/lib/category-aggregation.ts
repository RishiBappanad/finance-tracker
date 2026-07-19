/**
 * Category-aggregation for cash-flow reporting.
 *
 * A transaction has exactly one userCategory, but a matched, itemized
 * receipt can have several items each in a different category (e.g. one
 * Target run: groceries + a phone case + shampoo). Before this, cash-flow
 * totals only ever knew about the whole-transaction category, so an
 * itemized receipt's categorization was invisible to reporting — the
 * pie chart and category totals always showed 100% of the transaction
 * under one bucket, even if the user had carefully categorized each item.
 *
 * This splits a transaction's amount across its matched receipt's item
 * categories, proportional to each item's lineTotal, and falls back to the
 * transaction's own userCategory when there's no matched itemized receipt
 * (the common case — most transactions have no receipt at all).
 *
 * Uncategorized spend gets its own "Uncategorized" bucket, distinct from
 * "Other" (a real, selectable category someone might pick on purpose). The
 * previous version of this aggregation excluded uncategorized transactions
 * entirely (WHERE userCategory IS NOT NULL) — this surfaces them instead,
 * since money that was never categorized shouldn't silently vanish from a
 * spending report.
 */
import { db } from "@workspace/db";
import { bankTransactions, accounts, institutions, receiptTransactionMatches, receiptItems } from "@workspace/db";
import { eq, and, gte, lte, sql, inArray, type SQL } from "drizzle-orm";

export const UNCATEGORIZED = "Uncategorized";

export interface CategoryTotal {
  category: string;
  total: number;
  count: number;
}

interface AggregateOptions {
  userId: number;
  from?: string;
  to?: string;
  direction: "spending" | "earnings"; // spending: amount > 0, earnings: amount < 0
}

export async function aggregateByCategory({ userId, from, to, direction }: AggregateOptions): Promise<CategoryTotal[]> {
  const amountCondition: SQL = direction === "spending" ? sql`${bankTransactions.amount} > 0` : sql`${bankTransactions.amount} < 0`;

  const conditions = [amountCondition, eq(bankTransactions.ignored, false), eq(institutions.userId, userId)];
  if (from) conditions.push(gte(bankTransactions.date, from));
  if (to) conditions.push(lte(bankTransactions.date, to));

  const txns = await db
    .select({
      id: bankTransactions.id,
      amount: bankTransactions.amount,
      userCategory: bankTransactions.userCategory,
    })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(...conditions));

  if (txns.length === 0) return [];

  const txnIds = txns.map((t) => t.id);

  // Matched receipt + its items, for every qualifying transaction in one go
  const matchedItems = await db
    .select({
      bankTransactionId: receiptTransactionMatches.bankTransactionId,
      category: receiptItems.category,
      lineTotal: receiptItems.lineTotal,
    })
    .from(receiptTransactionMatches)
    .innerJoin(receiptItems, eq(receiptItems.receiptId, receiptTransactionMatches.receiptId))
    .where(inArray(receiptTransactionMatches.bankTransactionId, txnIds));

  const itemsByTxn = new Map<string, { category: string | null; lineTotal: number }[]>();
  for (const row of matchedItems) {
    const list = itemsByTxn.get(row.bankTransactionId) ?? [];
    list.push({ category: row.category, lineTotal: row.lineTotal });
    itemsByTxn.set(row.bankTransactionId, list);
  }

  const totals = new Map<string, { total: number; count: number }>();
  const bump = (category: string, amount: number) => {
    const existing = totals.get(category) ?? { total: 0, count: 0 };
    existing.total += amount;
    existing.count += 1;
    totals.set(category, existing);
  };

  for (const txn of txns) {
    const absAmount = Math.abs(txn.amount);
    const items = itemsByTxn.get(txn.id);

    if (items && items.length > 0) {
      const itemsTotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
      if (itemsTotal > 0) {
        // Split proportionally by each item's share of the receipt total.
        for (const item of items) {
          const share = item.lineTotal / itemsTotal;
          bump(item.category ?? UNCATEGORIZED, absAmount * share);
        }
        continue;
      }
    }

    // No matched itemized receipt (or items summed to zero) — fall back to
    // the transaction's own category.
    bump(txn.userCategory ?? UNCATEGORIZED, absAmount);
  }

  return [...totals.entries()]
    .map(([category, { total, count }]) => ({ category, total: Math.round(total * 100) / 100, count }))
    .sort((a, b) => b.total - a.total);
}
