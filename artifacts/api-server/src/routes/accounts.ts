import { Router } from "express";
import { db } from "@workspace/db";
import { accounts, institutions } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateAccountBody } from "@workspace/api-zod";
import { getPlaidAdapter } from "../services/plaid.js";

const router = Router();

// POST /accounts/create-link-token — generates a Plaid Link token for the frontend.
// SECURITY FIX (2026-08-27): client_user_id was hardcoded to the literal
// string "local-user-1" for EVERY user of this app. Plaid uses
// client_user_id specifically to recognize a returning user in Link --
// with every user sharing one ID, Plaid treated every new signup as the
// SAME person who'd connected before, and could skip phone-number entry
// entirely, sending an OTP straight to whatever phone number was
// already on file for that ID (the first person who ever linked a
// bank). This is what caused a second user's Plaid Link flow to
// silently text the first user's phone instead of prompting for their
// own number. Fixed by using this app's own per-user id, which is what
// every other Plaid-adjacent write in this file already scopes by.
router.post("/create-link-token", async (req, res) => {
  const { PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV = "sandbox" } = process.env;
  if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    return void res.status(500).json({ error: "Plaid credentials not configured" });
  }

  const response = await fetch(`https://${PLAID_ENV}.plaid.com/link/token/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: PLAID_CLIENT_ID,
      secret: PLAID_SECRET,
      user: { client_user_id: String(req.user!.userId) },
      client_name: "Receipt Wallet",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    }),
  });

  const data = (await response.json()) as any;
  if (!response.ok) {
    return void res.status(400).json({ error: data.error_message ?? "Failed to create link token" });
  }

  res.json({ linkToken: data.link_token });
});

router.get("/", async (req, res) => {
  const rows = await db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      mask: accounts.mask,
      currency: accounts.currency,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .leftJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(institutions.userId, req.user!.userId))
    .orderBy(accounts.createdAt);

  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString() ?? "" })));
});

router.post("/", async (req, res) => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const { publicToken, institutionId, institutionName } = parsed.data;
  const plaid = getPlaidAdapter();

  const { accessToken, itemId } = await plaid.exchangePublicToken(publicToken);
  const rawAccounts = await plaid.getAccounts(accessToken);

  await db
    .insert(institutions)
    .values({
      id: institutionId,
      name: institutionName,
      userId: req.user!.userId,
      plaidAccessToken: accessToken,
      plaidItemId: itemId,
    })
    .onConflictDoNothing();

  // Update access token if institution already exists but didn't have one
  await db
    .update(institutions)
    .set({ plaidAccessToken: accessToken, plaidItemId: itemId })
    .where(eq(institutions.id, institutionId));

  if (rawAccounts.length === 0) {
    return void res.status(400).json({ error: "No accounts returned from provider" });
  }

  for (const acct of rawAccounts) {
    await db
      .insert(accounts)
      .values({
        id: acct.accountId,
        institutionId,
        name: acct.name,
        type: acct.type,
        subtype: acct.subtype,
        mask: acct.mask,
        currency: acct.currency,
      })
      .onConflictDoNothing();
  }

  const first = rawAccounts[0];
  const row = await db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      mask: accounts.mask,
      currency: accounts.currency,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .leftJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.id, first.accountId))
    .limit(1);

  res.status(201).json({ ...row[0], createdAt: row[0]?.createdAt?.toISOString() ?? "" });
});

// SECURITY FIX (2026-08-27): no ownership check at all -- any authenticated
// user could view any other user's linked account by guessing/enumerating
// accountId. leftJoin -> innerJoin since an orphaned account (no
// institution row) can never belong to the caller anyway.
router.get("/:accountId", async (req, res) => {
  const rows = await db
    .select({
      id: accounts.id,
      institutionId: accounts.institutionId,
      institutionName: institutions.name,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      mask: accounts.mask,
      currency: accounts.currency,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(eq(accounts.id, req.params.accountId), eq(institutions.userId, req.user!.userId)))
    .limit(1);

  if (!rows.length) return void res.status(404).json({ error: "Account not found" });
  res.json({ ...rows[0], createdAt: rows[0].createdAt?.toISOString() ?? "" });
});

// SECURITY FIX (2026-08-27): no ownership check -- any authenticated user
// could delete any other user's linked bank account. Verify ownership
// first (same join as GET /:accountId above) before deleting.
router.delete("/:accountId", async (req, res) => {
  const owned = await db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(and(eq(accounts.id, req.params.accountId), eq(institutions.userId, req.user!.userId)))
    .limit(1);

  if (!owned.length) return void res.status(404).json({ error: "Account not found" });

  await db.delete(accounts).where(eq(accounts.id, req.params.accountId));
  res.status(204).send();
});

export default router;
