import { Router } from "express";
import { db } from "@workspace/db";
import { accounts, institutions } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateAccountBody } from "@workspace/api-zod";
import { getPlaidAdapter } from "../services/plaid.js";

const router = Router();

router.get("/", async (_req, res) => {
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
    .orderBy(accounts.createdAt);

  res.json(rows.map((r) => ({ ...r, createdAt: r.createdAt?.toISOString() ?? "" })));
});

router.post("/", async (req, res) => {
  const parsed = CreateAccountBody.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "Invalid input" });

  const { publicToken, institutionId, institutionName } = parsed.data;
  const plaid = getPlaidAdapter();

  const { accessToken } = await plaid.exchangePublicToken(publicToken);
  const rawAccounts = await plaid.getAccounts(accessToken);

  await db
    .insert(institutions)
    .values({ id: institutionId, name: institutionName })
    .onConflictDoNothing();

  if (rawAccounts.length === 0) {
    return void res.status(400).json({ error: "No accounts returned from provider" });
  }

  const first = rawAccounts[0];
  const [inserted] = await db
    .insert(accounts)
    .values({
      id: first.accountId,
      institutionId,
      name: first.name,
      type: first.type,
      subtype: first.subtype,
      mask: first.mask,
      currency: first.currency,
    })
    .onConflictDoNothing()
    .returning();

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
    .where(eq(accounts.id, inserted?.id ?? first.accountId))
    .limit(1);

  res.status(201).json({ ...row[0], createdAt: row[0]?.createdAt?.toISOString() ?? "" });
});

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
    .leftJoin(institutions, eq(accounts.institutionId, institutions.id))
    .where(eq(accounts.id, req.params.accountId))
    .limit(1);

  if (!rows.length) return void res.status(404).json({ error: "Account not found" });
  res.json({ ...rows[0], createdAt: rows[0].createdAt?.toISOString() ?? "" });
});

router.delete("/:accountId", async (req, res) => {
  await db.delete(accounts).where(eq(accounts.id, req.params.accountId));
  res.status(204).send();
});

export default router;
