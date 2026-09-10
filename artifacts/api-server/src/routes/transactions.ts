import { Router } from "express";
import { db } from "@workspace/db";
import { bankTransactions, accounts, institutions, receiptTransactionMatches, joinTransactionOwnership, ownedByUser } from "@workspace/db";
import { eq, and, gte, lte, like, sql, isNull, inArray } from "drizzle-orm";
import { ListTransactionsQueryParams } from "@workspace/api-zod";
import { getPlaidAdapter } from "../services/plaid.js";
import { categorizeTransactions, type TransactionInput } from "../services/categorizer.js";
import { getAllCategoryNames } from "../lib/categories.js";
import { aggregateByCategory } from "../lib/category-aggregation.js";

const router = Router();

function serializeTxn(t: any, matchId?: number | null) {
  return {
    id: t.id,
    accountId: t.accountId,
    accountName: t.accountName ?? null,
    accountMask: t.accountMask ?? null,
    amount: t.amount,
    currency: t.currency,
    merchantName: t.merchantName ?? null,
    merchantNameRaw: t.merchantNameRaw ?? null,
    categoryPrimary: t.categoryPrimary ?? null,
    categoryDetail: t.categoryDetail ?? null,
    userCategory: t.userCategory ?? null,
    ignored: t.ignored ?? false,
    date: t.date,
    pending: t.pending,
    matchId: matchId ?? null,
    createdAt: t.createdAt?.toISOString?.() ?? t.createdAt ?? "",
  };
}

// GET /transactions/ignored — list the CALLING USER's hidden/ignored
// transactions. SECURITY FIX (2026-08-27): this previously had no user
// filter at all -- eq(bankTransactions.ignored, true) with no join back
// to institutions.userId, so it returned every user's ignored
// transactions to any authenticated caller. Confirmed exploited: the
// frontend's Transactions page calls this directly.
router.get("/ignored", async (req, res) => {
  const rows = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      accountId: bankTransactions.accountId,
      accountName: accounts.name,
      accountMask: accounts.mask,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      categoryPrimary: bankTransactions.categoryPrimary,
      categoryDetail: bankTransactions.categoryDetail,
      userCategory: bankTransactions.userCategory,
      ignored: bankTransactions.ignored,
      date: bankTransactions.date,
      pending: bankTransactions.pending,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions).$dynamic())
    .where(and(eq(bankTransactions.ignored, true), ownedByUser(req.user!.userId)))
    .orderBy(bankTransactions.date);

  res.json(rows.map((r) => serializeTxn(r)));
});

// SECURITY FIX (2026-08-27): same missing-filter bug as /ignored above --
// this returned every user's unmatched transactions to any caller.
router.get("/unmatched", async (req, res) => {
  const userId = req.user!.userId;
  const matched = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const rows = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      accountId: bankTransactions.accountId,
      accountName: accounts.name,
      accountMask: accounts.mask,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      categoryPrimary: bankTransactions.categoryPrimary,
      categoryDetail: bankTransactions.categoryDetail,
      userCategory: bankTransactions.userCategory,
      ignored: bankTransactions.ignored,
      date: bankTransactions.date,
      pending: bankTransactions.pending,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions).$dynamic())
    .where(and(ownedByUser(userId), sql`${bankTransactions.id} NOT IN (${matched})`))
    .orderBy(bankTransactions.date);

  res.json(rows.map((r) => serializeTxn(r)));
});

router.get("/", async (req, res) => {
  const parsed = ListTransactionsQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [ownedByUser(req.user!.userId)];
  if (params.accountId) conditions.push(eq(bankTransactions.accountId, params.accountId));
  if (params.pending != null) conditions.push(eq(bankTransactions.pending, params.pending));
  if (params.from) conditions.push(gte(bankTransactions.date, params.from));
  if (params.to) conditions.push(lte(bankTransactions.date, params.to));
  if (params.search)
    conditions.push(like(bankTransactions.merchantName, `%${params.search}%`));

  const rows = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      accountId: bankTransactions.accountId,
      accountName: accounts.name,
      accountMask: accounts.mask,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      categoryPrimary: bankTransactions.categoryPrimary,
      categoryDetail: bankTransactions.categoryDetail,
      userCategory: bankTransactions.userCategory,
      ignored: bankTransactions.ignored,
      date: bankTransactions.date,
      pending: bankTransactions.pending,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions).$dynamic())
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(bankTransactions.date);

  // Attach matchId from matches table
  const matchRows = await db
    .select({ txnId: receiptTransactionMatches.bankTransactionId, id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches);
  const matchMap = new Map(matchRows.map((m) => [m.txnId, m.id]));

  res.json(rows.map((r) => serializeTxn(r, matchMap.get(r.id))));
});

router.post("/sync", async (req, res) => {
  const plaid = getPlaidAdapter();

  // Get all institutions with access tokens for this user
  let allInstitutions;
  try {
    allInstitutions = await db.select().from(institutions).where(eq(institutions.userId, req.user!.userId));
  } catch (e: any) {
    return void res.status(503).json({
      error: "Database unavailable",
      details: "Could not fetch account information. Please try again.",
    });
  }
  const institutionMap = new Map(allInstitutions.map((i) => [i.id, i]));

  const allAccounts = await db.select().from(accounts);

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const processedInstitutions = new Set<string>();
  const errors: Array<{ institution: string; error: string }> = [];

  for (const account of allAccounts) {
    const institution = institutionMap.get(account.institutionId);
    if (!institution?.plaidAccessToken) continue;
    if (processedInstitutions.has(institution.id)) continue;
    processedInstitutions.add(institution.id);

    try {
      // Paginate through all available transactions
      let cursor = institution.plaidSyncCursor ?? undefined;
      let hasMore = true;

      while (hasMore) {
        const result = await plaid.syncTransactions(institution.plaidAccessToken, cursor);

        for (const t of result.added) {
          await db
            .insert(bankTransactions)
            .values({
              id: t.transactionId,
              accountId: t.accountId,
              amount: t.amount,
              currency: t.isoCurrencyCode,
              merchantName: t.merchantName,
              merchantNameRaw: t.name,
              categoryPrimary: t.category[0] ?? null,
              categoryDetail: t.category[1] ?? null,
              date: t.date,
              pending: t.pending,
              // Explicit even though `source` defaults to "plaid" at the
              // column level -- this is the actual write site that
              // determines it, matching how every other write site sets
              // its own source rather than relying on the column default
              // implicitly (see EVENT_CONTRACT_SPEC.md's Resolved
              // Decision #2). sourceId = Plaid's own transactionId,
              // which also happens to be this row's `id` today -- kept
              // as a separate field anyway so dedup logic isn't relying
              // on `id`'s meaning never changing.
              source: "plaid",
              sourceId: t.transactionId,
            })
            .onConflictDoNothing();
          totalAdded++;
        }

        for (const t of result.modified) {
          await db
            .update(bankTransactions)
            .set({
              amount: t.amount,
              merchantName: t.merchantName,
              merchantNameRaw: t.name,
              categoryPrimary: t.category[0] ?? null,
              categoryDetail: t.category[1] ?? null,
              date: t.date,
              pending: t.pending,
            })
            .where(eq(bankTransactions.id, t.transactionId));
          totalModified++;
        }

        for (const id of result.removed) {
          await db.delete(bankTransactions).where(eq(bankTransactions.id, id));
          totalRemoved++;
        }

        cursor = result.nextCursor;

        // Plaid tells us if there are more pages
        hasMore = result.hasMore;

        // Save cursor after each page
        if (cursor) {
          await db
            .update(institutions)
            .set({ plaidSyncCursor: cursor })
            .where(eq(institutions.id, institution.id));
        }
      }
    } catch (e: any) {
      // Per-institution failures are non-fatal — collect and report
      errors.push({
        institution: institution.name ?? institution.id,
        error: e?.message ?? "Sync failed",
      });
      console.error(`Sync failed for institution ${institution.id}:`, e?.message ?? e);
    }
  }

  res.json({ added: totalAdded, removed: totalRemoved, updated: totalModified, accounts: allAccounts.length, errors });
});

// GET /transactions/vendors — list the CALLING USER's distinct merchant
// names. SECURITY FIX (2026-08-27): no user filter at all -- leaked
// every user's vendor/merchant names to any authenticated caller.
router.get("/vendors", async (req, res) => {
  const userId = req.user!.userId;
  const rows = await joinTransactionOwnership(db
    .select({
      vendor: bankTransactions.merchantName,
    })
    .from(bankTransactions).$dynamic())
    .where(and(
      ownedByUser(userId),
      sql`${bankTransactions.merchantName} IS NOT NULL AND ${bankTransactions.merchantName} != ''`
    ))
    .groupBy(bankTransactions.merchantName)
    .orderBy(bankTransactions.merchantName);

  // Also include merchantNameRaw for transactions without a merchantName
  const rawRows = await joinTransactionOwnership(db
    .select({
      vendor: bankTransactions.merchantNameRaw,
    })
    .from(bankTransactions).$dynamic())
    .where(
      and(
        ownedByUser(userId),
        sql`${bankTransactions.merchantName} IS NULL AND ${bankTransactions.merchantNameRaw} IS NOT NULL AND ${bankTransactions.merchantNameRaw} != ''`
      )
    )
    .groupBy(bankTransactions.merchantNameRaw)
    .orderBy(bankTransactions.merchantNameRaw);

  const vendors = [
    ...rows.map((r) => r.vendor!),
    ...rawRows.map((r) => r.vendor!),
  ].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  // Deduplicate
  res.json([...new Set(vendors)]);
});

// POST /transactions/bulk-categorize — assign category to all of the
// CALLING USER's OWN transactions from a merchant.
// SECURITY FIX (2026-08-27): this previously updated EVERY user's
// transactions matching merchantName, with no ownership check at all --
// any authenticated user recategorizing e.g. "Starbucks" would silently
// rewrite every other user's Starbucks transactions too. Drizzle's
// update().where() can't join, so ownership is enforced by first
// SELECTing the caller's own matching transaction ids (via the same
// institutions.userId join used everywhere else), then updating only
// those ids.
router.post("/bulk-categorize", async (req, res) => {
  const { merchantName, userCategory } = req.body;
  const userId = req.user!.userId;

  if (!merchantName || !userCategory) {
    return void res.status(400).json({ error: "merchantName and userCategory are required" });
  }

  // Validate category
  const allValid = await getAllCategoryNames();
  if (!allValid.includes(userCategory)) {
    return void res.status(400).json({ error: "Invalid category" });
  }

  const ownedIds = await joinTransactionOwnership(db
    .select({ id: bankTransactions.id })
    .from(bankTransactions).$dynamic())
    .where(and(
      ownedByUser(userId),
      sql`(${bankTransactions.merchantName} = ${merchantName} OR (${bankTransactions.merchantName} IS NULL AND ${bankTransactions.merchantNameRaw} = ${merchantName}))`
    ));

  if (ownedIds.length === 0) {
    return void res.json({ updated: 0, merchantName, userCategory });
  }

  const ids = ownedIds.map((r) => r.id);
  const updated = await db
    .update(bankTransactions)
    .set({ userCategory })
    .where(inArray(bankTransactions.id, ids))
    .returning({ id: bankTransactions.id });

  res.json({ updated: updated.length, merchantName, userCategory });
});

// POST /transactions/categorize — batch AI categorization for the CALLING
// USER's own uncategorized transactions.
// SECURITY FIX (2026-08-27): no user filter -- this selected and
// AI-categorized every user's uncategorized transactions, silently
// writing results into other users' data.
router.post("/categorize", async (req, res) => {
  const userId = req.user!.userId;
  const uncategorized = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      amount: bankTransactions.amount,
      categoryPrimary: bankTransactions.categoryPrimary,
      categoryDetail: bankTransactions.categoryDetail,
    })
    .from(bankTransactions).$dynamic())
    .where(and(ownedByUser(userId), isNull(bankTransactions.userCategory)));

  if (uncategorized.length === 0) {
    return void res.json({ categorized: 0, total: 0, breakdown: {} });
  }

  const inputs: TransactionInput[] = uncategorized.map((t) => ({
    id: t.id,
    merchantName: t.merchantName,
    merchantNameRaw: t.merchantNameRaw,
    amount: t.amount,
    categoryPrimary: t.categoryPrimary,
    categoryDetail: t.categoryDetail,
  }));

  const results = await categorizeTransactions(inputs);

  // Write categories to DB
  let categorized = 0;
  const breakdown: Record<string, number> = {};
  for (const result of results) {
    await db
      .update(bankTransactions)
      .set({ userCategory: result.category })
      .where(eq(bankTransactions.id, result.id));
    categorized++;
    breakdown[result.category] = (breakdown[result.category] ?? 0) + 1;
  }

  res.json({ categorized, total: uncategorized.length, breakdown });
});

// GET /transactions/categories — list available categories (default + user-created)
router.get("/categories", async (_req, res) => {
  res.json(await getAllCategoryNames());
});

// GET /transactions/spending-by-category — aggregated spending by category
router.get("/spending-by-category", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const rows = await aggregateByCategory({ userId: req.user!.userId, from, to, direction: "spending" });
  res.json(rows);
});

// GET /transactions/earnings-by-category — aggregated earnings (income) by category
router.get("/earnings-by-category", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const rows = await aggregateByCategory({ userId: req.user!.userId, from, to, direction: "earnings" });
  res.json(rows);
});

// PATCH /transactions/:transactionId — update category or ignored status
router.patch("/:transactionId", async (req, res) => {
  const { userCategory, ignored } = req.body;

  // Verify the transaction belongs to this user
  const ownership = await joinTransactionOwnership(db
    .select({ id: bankTransactions.id })
    .from(bankTransactions).$dynamic())
    .where(and(
      eq(bankTransactions.id, req.params.transactionId),
      ownedByUser(req.user!.userId)
    ))
    .limit(1);

  if (!ownership.length) {
    return void res.status(404).json({ error: "Transaction not found" });
  }

  const updates: Record<string, any> = {};

  if (userCategory !== undefined) {
    // Accept both default and user-created categories
    const allValid = await getAllCategoryNames();
    if (!allValid.includes(userCategory)) {
      return void res.status(400).json({ error: "Invalid category", validCategories: allValid });
    }
    updates.userCategory = userCategory;
  }

  if (ignored !== undefined) {
    updates.ignored = Boolean(ignored);
  }

  if (Object.keys(updates).length === 0) {
    return void res.status(400).json({ error: "Nothing to update" });
  }

  const [updated] = await db
    .update(bankTransactions)
    .set(updates)
    .where(eq(bankTransactions.id, req.params.transactionId))
    .returning();

  if (!updated) return void res.status(404).json({ error: "Transaction not found" });

  const match = await db
    .select({ id: receiptTransactionMatches.id })
    .from(receiptTransactionMatches)
    .where(eq(receiptTransactionMatches.bankTransactionId, req.params.transactionId))
    .limit(1);

  res.json(serializeTxn(updated, match[0]?.id ?? null));
});

router.get("/:transactionId", async (req, res) => {
  const rows = await joinTransactionOwnership(db
    .select({
      id: bankTransactions.id,
      accountId: bankTransactions.accountId,
      accountName: accounts.name,
      accountMask: accounts.mask,
      amount: bankTransactions.amount,
      currency: bankTransactions.currency,
      merchantName: bankTransactions.merchantName,
      merchantNameRaw: bankTransactions.merchantNameRaw,
      categoryPrimary: bankTransactions.categoryPrimary,
      categoryDetail: bankTransactions.categoryDetail,
      userCategory: bankTransactions.userCategory,
      ignored: bankTransactions.ignored,
      date: bankTransactions.date,
      pending: bankTransactions.pending,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions).$dynamic())
    .where(and(
      eq(bankTransactions.id, req.params.transactionId),
      ownedByUser(req.user!.userId)
    ))
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
