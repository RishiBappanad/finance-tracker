import { Router } from "express";
import { db } from "@workspace/db";
import { bankTransactions, accounts, institutions, receiptTransactionMatches, userCategories } from "@workspace/db";
import { eq, and, gte, lte, like, sql, isNull } from "drizzle-orm";
import { ListTransactionsQueryParams } from "@workspace/api-zod";
import { getPlaidAdapter } from "../services/plaid.js";
import { categorizeTransactions, CATEGORIES, type TransactionInput } from "../services/categorizer.js";

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

// GET /transactions/ignored — list all hidden/ignored transactions
router.get("/ignored", async (_req, res) => {
  const rows = await db
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
    .from(bankTransactions)
    .leftJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .where(eq(bankTransactions.ignored, true))
    .orderBy(bankTransactions.date);

  res.json(rows.map((r) => serializeTxn(r)));
});

router.get("/unmatched", async (_req, res) => {
  const matched = db
    .select({ id: receiptTransactionMatches.bankTransactionId })
    .from(receiptTransactionMatches);

  const rows = await db
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
    .from(bankTransactions)
    .leftJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .where(sql`${bankTransactions.id} NOT IN (${matched})`)
    .orderBy(bankTransactions.date);

  res.json(rows.map((r) => serializeTxn(r)));
});

router.get("/", async (req, res) => {
  const parsed = ListTransactionsQueryParams.safeParse(req.query);
  const params = parsed.success ? parsed.data : {};

  const conditions = [eq(institutions.userId, req.user!.userId)];
  if (params.accountId) conditions.push(eq(bankTransactions.accountId, params.accountId));
  if (params.pending != null) conditions.push(eq(bankTransactions.pending, params.pending));
  if (params.from) conditions.push(gte(bankTransactions.date, params.from));
  if (params.to) conditions.push(lte(bankTransactions.date, params.to));
  if (params.search)
    conditions.push(like(bankTransactions.merchantName, `%${params.search}%`));

  const rows = await db
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
    .from(bankTransactions)
    .leftJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
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
  const allInstitutions = await db.select().from(institutions).where(eq(institutions.userId, req.user!.userId));
  const institutionMap = new Map(allInstitutions.map((i) => [i.id, i]));

  const allAccounts = await db.select().from(accounts);

  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  const processedInstitutions = new Set<string>();

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
      // Log but don't fail the whole sync
      console.error(`Sync failed for institution ${institution.id}:`, e?.message ?? e);
    }
  }

  res.json({ added: totalAdded, removed: totalRemoved, updated: totalModified, accounts: allAccounts.length });
});

// GET /transactions/vendors — list distinct merchant names
router.get("/vendors", async (_req, res) => {
  const rows = await db
    .select({
      vendor: bankTransactions.merchantName,
    })
    .from(bankTransactions)
    .where(sql`${bankTransactions.merchantName} IS NOT NULL AND ${bankTransactions.merchantName} != ''`)
    .groupBy(bankTransactions.merchantName)
    .orderBy(bankTransactions.merchantName);

  // Also include merchantNameRaw for transactions without a merchantName
  const rawRows = await db
    .select({
      vendor: bankTransactions.merchantNameRaw,
    })
    .from(bankTransactions)
    .where(
      sql`${bankTransactions.merchantName} IS NULL AND ${bankTransactions.merchantNameRaw} IS NOT NULL AND ${bankTransactions.merchantNameRaw} != ''`
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

// POST /transactions/bulk-categorize — assign category to all transactions from a merchant
router.post("/bulk-categorize", async (req, res) => {
  const { merchantName, userCategory } = req.body;

  if (!merchantName || !userCategory) {
    return void res.status(400).json({ error: "merchantName and userCategory are required" });
  }

  // Validate category
  const userCats = await db.select({ name: userCategories.name }).from(userCategories);
  const allValid = [...CATEGORIES, ...userCats.map((c) => c.name)];
  if (!allValid.includes(userCategory)) {
    return void res.status(400).json({ error: "Invalid category" });
  }

  // Update all matching transactions (by merchantName OR merchantNameRaw)
  const result1 = await db
    .update(bankTransactions)
    .set({ userCategory })
    .where(eq(bankTransactions.merchantName, merchantName))
    .returning({ id: bankTransactions.id });

  const result2 = await db
    .update(bankTransactions)
    .set({ userCategory })
    .where(
      and(
        isNull(bankTransactions.merchantName),
        eq(bankTransactions.merchantNameRaw, merchantName)
      )
    )
    .returning({ id: bankTransactions.id });

  const updated = result1.length + result2.length;
  res.json({ updated, merchantName, userCategory });
});

// POST /transactions/categorize — batch AI categorization for uncategorized transactions
router.post("/categorize", async (_req, res) => {
  // Get all transactions without a user_category
  const uncategorized = await db
    .select()
    .from(bankTransactions)
    .where(isNull(bankTransactions.userCategory));

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
  const userCats = await db.select().from(userCategories).orderBy(userCategories.name);
  const userCatNames = userCats.map((c) => c.name);
  // Merge: defaults first, then user-created (deduped)
  const all = [...CATEGORIES, ...userCatNames.filter((n) => !CATEGORIES.includes(n as any))];
  res.json(all);
});

// GET /transactions/spending-by-category — aggregated spending by category
router.get("/spending-by-category", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };

  const conditions = [
    sql`${bankTransactions.userCategory} IS NOT NULL`,
    sql`${bankTransactions.amount} > 0`,
    eq(bankTransactions.ignored, false),
    eq(institutions.userId, req.user!.userId),
  ];

  if (from) conditions.push(gte(bankTransactions.date, from));
  if (to) conditions.push(lte(bankTransactions.date, to));

  const rows = await db
    .select({
      category: bankTransactions.userCategory,
      total: sql<number>`SUM(${bankTransactions.amount})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(...conditions))
    .groupBy(bankTransactions.userCategory);

  res.json(
    rows.map((r) => ({
      category: r.category ?? "Other",
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    }))
  );
});

// GET /transactions/earnings-by-category — aggregated earnings (income) by category
router.get("/earnings-by-category", async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };

  const conditions = [
    sql`${bankTransactions.userCategory} IS NOT NULL`,
    sql`${bankTransactions.amount} < 0`,
    eq(bankTransactions.ignored, false),
    eq(institutions.userId, req.user!.userId),
  ];

  if (from) conditions.push(gte(bankTransactions.date, from));
  if (to) conditions.push(lte(bankTransactions.date, to));

  const rows = await db
    .select({
      category: bankTransactions.userCategory,
      total: sql<number>`SUM(ABS(${bankTransactions.amount}))`,
      count: sql<number>`COUNT(*)`,
    })
    .from(bankTransactions)
    .innerJoin(accounts, eq(bankTransactions.accountId, accounts.id))
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(...conditions))
    .groupBy(bankTransactions.userCategory);

  res.json(
    rows.map((r) => ({
      category: r.category ?? "Other",
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    }))
  );
});

// PATCH /transactions/:transactionId — update category or ignored status
router.patch("/:transactionId", async (req, res) => {
  const { userCategory, ignored } = req.body;

  const updates: Record<string, any> = {};

  if (userCategory !== undefined) {
    // Accept both default and user-created categories
    const userCats = await db.select({ name: userCategories.name }).from(userCategories);
    const allValid = [...CATEGORIES, ...userCats.map((c) => c.name)];
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
