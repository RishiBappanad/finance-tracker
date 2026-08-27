import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { db, users, institutions, accounts, bankTransactions, scannedReceipts, receiptItems, receiptTransactionMatches } from "@workspace/db";
import { eq } from "drizzle-orm";

// Live-database counterpart to user-scoping.test.ts. That file runs against
// tests/helpers/db-mock.ts, whose .where()/.innerJoin() calls ignore their
// arguments entirely -- it can assert response *shape* but can never prove a
// query actually filters by user. This file makes real HTTP requests
// through the real (unmocked) Express app against a real Postgres database
// (a disposable Neon branch, matching the pattern used for
// nutrition-insights' fiber/macro migrations), seeds two distinct users'
// real rows via @workspace/db's real drizzle client, and asserts that
// neither can see, edit, or delete the other's data. This is what actually
// verifies the 2026-08-27 data-isolation fixes across transactions.ts,
// accounts.ts, receipts.ts, and matches.ts -- a typecheck alone can't.
//
// Requires DATABASE_URL to point at a real, disposable database. Run via:
//   DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const A_ID = 900_000_000 + (RUN % 90_000_000);
const B_ID = A_ID + 1;

function authHeader(accountId: number, email: string) {
  const token = jwt.sign({ accountId, email }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const userA = { id: A_ID, email: `live-test-a-${RUN}@test.trackstack.invalid` };
const userB = { id: B_ID, email: `live-test-b-${RUN}@test.trackstack.invalid` };
const headersA = authHeader(userA.id, userA.email);
const headersB = authHeader(userB.id, userB.email);

interface Fixture {
  institutionId: string;
  accountId: string;
  ignoredTxnId: string;
  unmatchedTxnId: string;
  uncatTxnId: string;
  bulkTxnId: string;
  matchedTxnId: string;
  matchCandidateTxnId: string;
  unmatchedReceiptId: number;
  expiringReceiptId: number;
  matchedReceiptId: number;
  matchCandidateReceiptId: number;
  itemId: number;
  existingMatchId: number;
}

async function seedUser(suffix: "a" | "b", accountId: number, uncatMerchant: string): Promise<Fixture> {
  const institutionId = `test-${RUN}-inst-${suffix}`;
  const acctId = `test-${RUN}-acc-${suffix}`;

  await db.insert(institutions).values({ id: institutionId, userId: accountId, name: `Live Test Bank ${suffix.toUpperCase()}` });
  await db.insert(accounts).values({ id: acctId, institutionId, name: `Checking ${suffix}`, type: "depository", subtype: "checking", mask: "0000" });

  const txn = (idSuffix: string, overrides: Partial<typeof bankTransactions.$inferInsert> = {}) => ({
    id: `test-${RUN}-txn-${suffix}-${idSuffix}`,
    accountId: acctId,
    amount: 42.5,
    merchantName: `Live Test ${suffix.toUpperCase()} ${idSuffix}`,
    date: "2026-08-01",
    ...overrides,
  });

  const ignoredTxnId = `test-${RUN}-txn-${suffix}-ignored`;
  const unmatchedTxnId = `test-${RUN}-txn-${suffix}-unmatched`;
  const uncatTxnId = `test-${RUN}-txn-${suffix}-uncat`;
  const bulkTxnId = `test-${RUN}-txn-${suffix}-bulk`;
  const matchedTxnId = `test-${RUN}-txn-${suffix}-matched`;
  const matchCandidateTxnId = `test-${RUN}-txn-${suffix}-matchcand`;

  // Every txn except uncatTxn/bulkTxn is pre-categorized so it's excluded
  // from POST /categorize's isNull(userCategory) candidate set below --
  // otherwise this fixture's own ignored/unmatched/matched/matchcand rows
  // would inflate that test's "uncategorized" count.
  await db.insert(bankTransactions).values([
    txn("ignored", { id: ignoredTxnId, ignored: true, userCategory: "Other" }),
    txn("unmatched", { id: unmatchedTxnId, merchantName: `Live Test Vendor ${suffix.toUpperCase()}`, userCategory: "Other" }),
    txn("uncat", { id: uncatTxnId, merchantName: uncatMerchant, userCategory: null }),
    txn("bulk", { id: bulkTxnId, merchantName: "SharedTestMerchant123", userCategory: null }),
    txn("matched", { id: matchedTxnId, userCategory: "Other" }),
    txn("matchcand", { id: matchCandidateTxnId, userCategory: "Other" }),
  ]);

  const [unmatchedReceipt] = await db
    .insert(scannedReceipts)
    .values({ userId: accountId, sourceFilePath: `/uploads/live-${suffix}-unmatched.jpg`, storeName: `Live Test ${suffix.toUpperCase()} Store`, purchaseDate: "2026-08-01", total: 42.5, processingStatus: "completed" })
    .returning();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() + 5);
  const [expiringReceipt] = await db
    .insert(scannedReceipts)
    .values({ userId: accountId, sourceFilePath: `/uploads/live-${suffix}-expiring.jpg`, storeName: `Live Test ${suffix.toUpperCase()} Expiring`, purchaseDate: "2026-08-01", total: 10, processingStatus: "completed", returnDeadline: cutoffDate.toISOString().slice(0, 10) })
    .returning();

  const [matchedReceipt] = await db
    .insert(scannedReceipts)
    .values({ userId: accountId, sourceFilePath: `/uploads/live-${suffix}-matched.jpg`, storeName: `Live Test ${suffix.toUpperCase()} Matched`, purchaseDate: "2026-08-01", total: 42.5, processingStatus: "completed" })
    .returning();

  const [matchCandidateReceipt] = await db
    .insert(scannedReceipts)
    .values({ userId: accountId, sourceFilePath: `/uploads/live-${suffix}-matchcand.jpg`, storeName: `Live Test ${suffix.toUpperCase()} MatchCand`, purchaseDate: "2026-08-01", total: 42.5, processingStatus: "completed" })
    .returning();

  const [item] = await db
    .insert(receiptItems)
    .values({ receiptId: unmatchedReceipt.id, description: `Live test item ${suffix}`, unitPrice: 42.5, lineTotal: 42.5 })
    .returning();

  const [existingMatch] = await db
    .insert(receiptTransactionMatches)
    .values({ receiptId: matchedReceipt.id, bankTransactionId: matchedTxnId, matchMethod: "manual", confirmed: true })
    .returning();

  return {
    institutionId,
    accountId: acctId,
    ignoredTxnId,
    unmatchedTxnId,
    uncatTxnId,
    bulkTxnId,
    matchedTxnId,
    matchCandidateTxnId,
    unmatchedReceiptId: unmatchedReceipt.id,
    expiringReceiptId: expiringReceipt.id,
    matchedReceiptId: matchedReceipt.id,
    matchCandidateReceiptId: matchCandidateReceipt.id,
    itemId: item.id,
    existingMatchId: existingMatch.id,
  };
}

let fixA: Fixture;
let fixB: Fixture;

beforeAll(async () => {
  await db.insert(users).values([
    { id: userA.id, email: userA.email },
    { id: userB.id, email: userB.email },
  ]);
  fixA = await seedUser("a", userA.id, "Starbucks");
  fixB = await seedUser("b", userB.id, "Netflix");
}, 30_000);

afterAll(async () => {
  // Best-effort cleanup, child-to-parent. The branch this runs against is
  // disposable and gets deleted after the test run regardless -- this just
  // keeps the run idempotent if it's ever re-pointed at a longer-lived branch.
  for (const suffix of ["a", "b"] as const) {
    const acctId = suffix === "a" ? userA.id : userB.id;
    await db.delete(receiptTransactionMatches).where(eq(receiptTransactionMatches.bankTransactionId, `test-${RUN}-txn-${suffix}-matched`)).catch(() => {});
  }
  await db.delete(receiptItems).where(eq(receiptItems.description, `Live test item a`)).catch(() => {});
  await db.delete(receiptItems).where(eq(receiptItems.description, `Live test item b`)).catch(() => {});
  await db.delete(scannedReceipts).where(eq(scannedReceipts.userId, userA.id)).catch(() => {});
  await db.delete(scannedReceipts).where(eq(scannedReceipts.userId, userB.id)).catch(() => {});
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, `test-${RUN}-acc-a`)).catch(() => {});
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, `test-${RUN}-acc-b`)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.institutionId, `test-${RUN}-inst-a`)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.institutionId, `test-${RUN}-inst-b`)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, `test-${RUN}-inst-a`)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, `test-${RUN}-inst-b`)).catch(() => {});
  await db.delete(users).where(eq(users.id, userA.id)).catch(() => {});
  await db.delete(users).where(eq(users.id, userB.id)).catch(() => {});
}, 30_000);

// ── transactions.ts ─────────────────────────────────────────────────────────

describe("transactions.ts cross-user isolation", () => {
  it("GET /ignored only returns the caller's own ignored transactions", async () => {
    const res = await request(app).get("/api/transactions/ignored").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.id);
    expect(ids).toContain(fixA.ignoredTxnId);
    expect(ids).not.toContain(fixB.ignoredTxnId);
  });

  it("GET /unmatched only returns the caller's own unmatched transactions", async () => {
    const res = await request(app).get("/api/transactions/unmatched").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((t: any) => t.id);
    expect(ids).toContain(fixA.unmatchedTxnId);
    expect(ids).not.toContain(fixB.unmatchedTxnId);
  });

  it("GET /vendors only returns the caller's own merchant names", async () => {
    const res = await request(app).get("/api/transactions/vendors").set(headersA);
    expect(res.status).toBe(200);
    expect(res.body).toContain("Live Test Vendor A");
    expect(res.body).not.toContain("Live Test Vendor B");
  });

  it("POST /bulk-categorize only updates the caller's own transactions, even with an identical merchant name", async () => {
    const res = await request(app)
      .post("/api/transactions/bulk-categorize")
      .set(headersA)
      .send({ merchantName: "SharedTestMerchant123", userCategory: "Shopping" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);

    const [ownRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fixA.bulkTxnId));
    const [otherRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fixB.bulkTxnId));
    expect(ownRow.userCategory).toBe("Shopping");
    expect(otherRow.userCategory).toBeNull();
  });

  it("POST /categorize only categorizes the caller's own uncategorized transactions", async () => {
    const res = await request(app).post("/api/transactions/categorize").set(headersA);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);

    const [ownRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fixA.uncatTxnId));
    const [otherRow] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fixB.uncatTxnId));
    expect(ownRow.userCategory).toBe("Food & Dining"); // Starbucks, rule-based
    expect(otherRow.userCategory).toBeNull(); // untouched by user A's call
  });

  it("GET /:transactionId 404s for another user's transaction, 200s for the caller's own", async () => {
    const own = await request(app).get(`/api/transactions/${fixA.unmatchedTxnId}`).set(headersA);
    expect(own.status).toBe(200);
    const foreign = await request(app).get(`/api/transactions/${fixB.unmatchedTxnId}`).set(headersA);
    expect(foreign.status).toBe(404);
  });

  it("PATCH /:transactionId 404s when targeting another user's transaction", async () => {
    const res = await request(app)
      .patch(`/api/transactions/${fixB.unmatchedTxnId}`)
      .set(headersA)
      .send({ ignored: true });
    expect(res.status).toBe(404);

    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, fixB.unmatchedTxnId));
    expect(row.ignored).toBe(false);
  });
});

// ── accounts.ts ──────────────────────────────────────────────────────────────

describe("accounts.ts cross-user isolation", () => {
  it("POST /create-link-token sends the caller's own userId as client_user_id, not a shared constant", async () => {
    const originalFetch = global.fetch;
    let capturedBody: any = null;
    global.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ link_token: "link-sandbox-test-token" }),
      } as any;
    }) as any;

    try {
      const resA = await request(app).post("/api/accounts/create-link-token").set(headersA);
      expect(resA.status).toBe(200);
      expect(capturedBody.user.client_user_id).toBe(String(userA.id));

      const resB = await request(app).post("/api/accounts/create-link-token").set(headersB);
      expect(resB.status).toBe(200);
      expect(capturedBody.user.client_user_id).toBe(String(userB.id));

      // The historical bug: this was hardcoded to the literal string
      // "local-user-1" for every user, which made Plaid treat every new
      // signup as a returning user and skip phone verification.
      expect(capturedBody.user.client_user_id).not.toBe("local-user-1");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("GET /:accountId 404s for another user's account, 200s for the caller's own", async () => {
    const own = await request(app).get(`/api/accounts/${fixA.accountId}`).set(headersA);
    expect(own.status).toBe(200);
    const foreign = await request(app).get(`/api/accounts/${fixB.accountId}`).set(headersA);
    expect(foreign.status).toBe(404);
  });

  it("DELETE /:accountId 404s and does not delete another user's account", async () => {
    const res = await request(app).delete(`/api/accounts/${fixB.accountId}`).set(headersA);
    expect(res.status).toBe(404);

    const [stillThere] = await db.select().from(accounts).where(eq(accounts.id, fixB.accountId));
    expect(stillThere).toBeDefined();
  });
});

// ── receipts.ts ──────────────────────────────────────────────────────────────

describe("receipts.ts cross-user isolation", () => {
  it("GET /expiring only returns the caller's own expiring receipts", async () => {
    const res = await request(app).get("/api/receipts/expiring").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(fixA.expiringReceiptId);
    expect(ids).not.toContain(fixB.expiringReceiptId);
  });

  it("GET /unmatched only returns the caller's own unmatched receipts", async () => {
    const res = await request(app).get("/api/receipts/unmatched").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(fixA.unmatchedReceiptId);
    expect(ids).not.toContain(fixB.unmatchedReceiptId);
  });

  it("GET / only returns the caller's own receipts", async () => {
    const res = await request(app).get("/api/receipts").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((r: any) => r.id);
    expect(ids).toContain(fixA.unmatchedReceiptId);
    expect(ids).not.toContain(fixB.unmatchedReceiptId);
  });

  it("GET /:receiptId 404s for another user's receipt, 200s for the caller's own", async () => {
    const own = await request(app).get(`/api/receipts/${fixA.unmatchedReceiptId}`).set(headersA);
    expect(own.status).toBe(200);
    const foreign = await request(app).get(`/api/receipts/${fixB.unmatchedReceiptId}`).set(headersA);
    expect(foreign.status).toBe(404);
  });

  it("GET /:receiptId/suggestions 404s for another user's receipt", async () => {
    const res = await request(app).get(`/api/receipts/${fixB.unmatchedReceiptId}/suggestions`).set(headersA);
    expect(res.status).toBe(404);
  });

  it("PATCH /:receiptId 404s and does not modify another user's receipt", async () => {
    const res = await request(app)
      .patch(`/api/receipts/${fixB.unmatchedReceiptId}`)
      .set(headersA)
      .send({ notes: "hijacked by user A" });
    expect(res.status).toBe(404);

    const [row] = await db.select().from(scannedReceipts).where(eq(scannedReceipts.id, fixB.unmatchedReceiptId));
    expect(row.notes).not.toBe("hijacked by user A");
  });

  it("DELETE /:receiptId does not delete another user's receipt", async () => {
    await request(app).delete(`/api/receipts/${fixB.expiringReceiptId}`).set(headersA);
    const [row] = await db.select().from(scannedReceipts).where(eq(scannedReceipts.id, fixB.expiringReceiptId));
    expect(row).toBeDefined();
  });

  it("GET /:receiptId/items 404s for another user's receipt", async () => {
    const res = await request(app).get(`/api/receipts/${fixB.unmatchedReceiptId}/items`).set(headersA);
    expect(res.status).toBe(404);
  });

  it("POST /:receiptId/items 404s and does not add an item to another user's receipt", async () => {
    const res = await request(app)
      .post(`/api/receipts/${fixB.unmatchedReceiptId}/items`)
      .set(headersA)
      .send({ description: "planted item", unitPrice: 1, lineTotal: 1 });
    expect(res.status).toBe(404);

    const items = await db.select().from(receiptItems).where(eq(receiptItems.receiptId, fixB.unmatchedReceiptId));
    expect(items.map((i) => i.description)).not.toContain("planted item");
  });

  it("PATCH /:receiptId/items/:itemId 404s for an item on another user's receipt", async () => {
    const res = await request(app)
      .patch(`/api/receipts/${fixB.unmatchedReceiptId}/items/${fixB.itemId}`)
      .set(headersA)
      .send({ description: "hijacked item" });
    expect(res.status).toBe(404);

    const [row] = await db.select().from(receiptItems).where(eq(receiptItems.id, fixB.itemId));
    expect(row.description).not.toBe("hijacked item");
  });
});

// ── matches.ts ───────────────────────────────────────────────────────────────

describe("matches.ts cross-user isolation", () => {
  it("GET / only returns the caller's own matches", async () => {
    const res = await request(app).get("/api/matches").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.map((m: any) => m.id);
    expect(ids).toContain(fixA.existingMatchId);
    expect(ids).not.toContain(fixB.existingMatchId);
  });

  it("POST / creates a match for the caller's own receipt + transaction", async () => {
    const res = await request(app)
      .post("/api/matches")
      .set(headersA)
      .send({ receiptId: fixA.matchCandidateReceiptId, bankTransactionId: fixA.matchCandidateTxnId });
    expect(res.status).toBe(201);
    expect(res.body.receiptId).toBe(fixA.matchCandidateReceiptId);
  });

  it("POST / 404s when the receiptId belongs to another user", async () => {
    const res = await request(app)
      .post("/api/matches")
      .set(headersA)
      .send({ receiptId: fixB.matchCandidateReceiptId, bankTransactionId: fixA.unmatchedTxnId });
    expect(res.status).toBe(404);
  });

  it("POST / 404s when the bankTransactionId belongs to another user", async () => {
    const res = await request(app)
      .post("/api/matches")
      .set(headersA)
      .send({ receiptId: fixA.unmatchedReceiptId, bankTransactionId: fixB.unmatchedTxnId });
    expect(res.status).toBe(404);
  });

  it("PATCH /:matchId 404s and does not modify another user's match", async () => {
    const res = await request(app)
      .patch(`/api/matches/${fixB.existingMatchId}`)
      .set(headersA)
      .send({ confirmed: false });
    expect(res.status).toBe(404);

    const [row] = await db.select().from(receiptTransactionMatches).where(eq(receiptTransactionMatches.id, fixB.existingMatchId));
    expect(row.confirmed).toBe(true);
  });

  it("DELETE /:matchId does not delete another user's match", async () => {
    const res = await request(app).delete(`/api/matches/${fixB.existingMatchId}`).set(headersA);
    expect(res.status).toBe(404);

    const [row] = await db.select().from(receiptTransactionMatches).where(eq(receiptTransactionMatches.id, fixB.existingMatchId));
    expect(row).toBeDefined();
  });
});
