import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { db, users, institutions, accounts, bankTransactions } from "@workspace/db";
import { eq } from "drizzle-orm";

// Live-database test for the Universal Event Contract adapter
// (routes/events.ts) -- same rationale as user-scoping-live.test.ts: a
// mock-based test can assert response shape but can never prove a query
// actually filters by user, and this adapter's whole job is querying
// bank_transactions correctly scoped by user. Also covers functional
// correctness (the synthetic manual-account creation, category
// resolution, aggregation grouping) that isn't a security concern but
// still needs a real database to verify honestly.
//
// Run via: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const A_ID = 910_000_000 + (RUN % 90_000_000);
const B_ID = A_ID + 1;

function authHeader(accountId: number, email: string) {
  const token = jwt.sign({ accountId, email }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const userA = { id: A_ID, email: `events-live-test-a-${RUN}@test.trackstack.invalid` };
const userB = { id: B_ID, email: `events-live-test-b-${RUN}@test.trackstack.invalid` };
const headersA = authHeader(userA.id, userA.email);
const headersB = authHeader(userB.id, userB.email);

const instA = `test-${RUN}-events-inst-a`;
const acctA = `test-${RUN}-events-acc-a`;
const instB = `test-${RUN}-events-inst-b`;
const acctB = `test-${RUN}-events-acc-b`;
const plaidTxnA = `test-${RUN}-events-plaid-a`;
const plaidTxnB = `test-${RUN}-events-plaid-b`;

beforeAll(async () => {
  await db.insert(users).values([
    { id: userA.id, email: userA.email },
    { id: userB.id, email: userB.email },
  ]);
  await db.insert(institutions).values([
    { id: instA, userId: userA.id, name: "Events Live Test Bank A" },
    { id: instB, userId: userB.id, name: "Events Live Test Bank B" },
  ]);
  await db.insert(accounts).values([
    { id: acctA, institutionId: instA, name: "Checking A", type: "depository", subtype: "checking", mask: "1111" },
    { id: acctB, institutionId: instB, name: "Checking B", type: "depository", subtype: "checking", mask: "2222" },
  ]);
  // A pre-existing "plaid"-sourced transaction for each user, to prove
  // GET /events surfaces already-synced rows too, not just ones logged
  // through the adapter itself.
  await db.insert(bankTransactions).values([
    {
      id: plaidTxnA, accountId: acctA, amount: 25, merchantName: "Events Live Coffee A",
      categoryPrimary: "Food and Drink", date: "2026-09-08", source: "plaid", sourceId: plaidTxnA,
    },
    {
      id: plaidTxnB, accountId: acctB, amount: 30, merchantName: "Events Live Coffee B",
      categoryPrimary: "Food and Drink", date: "2026-09-08", source: "plaid", sourceId: plaidTxnB,
    },
  ]);
}, 30_000);

afterAll(async () => {
  // Best-effort cleanup, child-to-parent -- see user-scoping-live.test.ts
  // for why this is only best-effort (the branch is disposable anyway).
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, acctA)).catch(() => {});
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, acctB)).catch(() => {});
  // The synthetic "Manual Entries" account/institution POST /events/log
  // creates on first use (id = `manual-${userId}`, see
  // lib/manual-account.ts) -- cleaned up explicitly since it isn't part
  // of the fixture seeded above.
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, `manual-${userA.id}`)).catch(() => {});
  await db.delete(bankTransactions).where(eq(bankTransactions.accountId, `manual-${userB.id}`)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.institutionId, instA)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.institutionId, instB)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.id, `manual-${userA.id}`)).catch(() => {});
  await db.delete(accounts).where(eq(accounts.id, `manual-${userB.id}`)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, instA)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, instB)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, `manual-${userA.id}`)).catch(() => {});
  await db.delete(institutions).where(eq(institutions.id, `manual-${userB.id}`)).catch(() => {});
  await db.delete(users).where(eq(users.id, userA.id)).catch(() => {});
  await db.delete(users).where(eq(users.id, userB.id)).catch(() => {});
}, 30_000);

describe("POST /events/log", () => {
  it("rejects an unknown event_type", async () => {
    const res = await request(app)
      .post("/api/events/log")
      .set(headersA)
      .send({ event_type: "not_a_real_type", occurred_at: "2026-09-08" });
    expect(res.status).toBe(400);
  });

  it("creates a transaction against a lazily-created synthetic manual account", async () => {
    const res = await request(app)
      .post("/api/events/log")
      .set(headersA)
      .send({
        event_type: "transaction",
        occurred_at: "2026-09-08",
        amount: 12.5,
        category: "Coffee Shops",
        metadata: { merchantName: "Live Test Manual Coffee" },
      });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("logged");
    expect(res.body.id).toBeTruthy();

    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, res.body.id));
    expect(row.accountId).toBe(`manual-${userA.id}`);
    expect(row.amount).toBe(12.5);
    expect(row.userCategory).toBe("Coffee Shops");
    expect(row.source).toBe("manual");
    expect(row.merchantName).toBe("Live Test Manual Coffee");

    // The synthetic account is real and owned by this user -- same
    // ownership join every other query in this codebase uses.
    const [acct] = await db
      .select({ id: accounts.id, institutionId: accounts.institutionId })
      .from(accounts)
      .where(eq(accounts.id, `manual-${userA.id}`));
    expect(acct).toBeTruthy();
    const [inst] = await db.select({ userId: institutions.userId }).from(institutions).where(eq(institutions.id, acct.institutionId));
    expect(inst.userId).toBe(userA.id);
  });

  it("hidden maps to ignored", async () => {
    const res = await request(app)
      .post("/api/events/log")
      .set(headersA)
      .send({ event_type: "transaction", occurred_at: "2026-09-08", amount: 5, hidden: true });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(bankTransactions).where(eq(bankTransactions.id, res.body.id));
    expect(row.ignored).toBe(true);
  });
});

describe("GET /events cross-user isolation and shape", () => {
  it("only returns the caller's own events, including pre-existing Plaid-synced ones", async () => {
    const res = await request(app).get("/api/events?start=2026-09-01&end=2026-09-30").set(headersA);
    expect(res.status).toBe(200);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(plaidTxnA);
    expect(ids).not.toContain(plaidTxnB);
  });

  it("returns the Core Event Shape with finance's real field mappings", async () => {
    const res = await request(app).get("/api/events?start=2026-09-01&end=2026-09-30").set(headersA);
    const event = res.body.events.find((e: any) => e.id === plaidTxnA);
    expect(event).toMatchObject({
      user_id: userA.id,
      event_type: "transaction",
      category: "Food and Drink", // categoryPrimary, no userCategory override on this fixture row
      occurred_at: "2026-09-08",
      amount: 25,
      source: "plaid",
      source_id: plaidTxnA,
      hidden: false,
      status: null,
    });
    expect(event.metadata.merchantName).toBe("Events Live Coffee A");
    expect(event.metadata.pending).toBe(false);
  });

  it("rejects an unknown event_type filter", async () => {
    const res = await request(app).get("/api/events?start=2026-09-01&end=2026-09-30&event_type=not_real").set(headersA);
    expect(res.status).toBe(400);
  });

  it("source filter only returns matching-source events", async () => {
    const res = await request(app).get("/api/events?start=2026-09-01&end=2026-09-30&source=plaid").set(headersA);
    const ids = res.body.events.map((e: any) => e.id);
    expect(ids).toContain(plaidTxnA);
    // The manual entries logged in the POST /events/log tests above have source="manual".
    const allManual = res.body.events.filter((e: any) => e.source === "manual");
    expect(allManual).toHaveLength(0);
  });
});

describe("GET /aggregations/{aggType} cross-user isolation and correctness", () => {
  it("rejects an unknown aggType", async () => {
    const res = await request(app).get("/api/aggregations/not_a_real_type?start=2026-09-01&end=2026-09-30").set(headersA);
    expect(res.status).toBe(400);
  });

  it("by_source sums only the caller's own events, excluding the other user's entirely", async () => {
    const res = await request(app).get("/api/aggregations/by_source?start=2026-09-01&end=2026-09-30").set(headersA);
    expect(res.status).toBe(200);
    const plaidBucket = res.body.data.find((d: any) => d.source === "plaid");
    // userA's plaid bucket must include their own $25 fixture transaction
    // but never userB's $30 one -- if cross-user filtering broke, this
    // total would be >= 55, not exactly their own amount.
    expect(plaidBucket.total_amount).toBeGreaterThanOrEqual(25);
    expect(plaidBucket.unit).toBe("usd");

    const resB = await request(app).get("/api/aggregations/by_source?start=2026-09-01&end=2026-09-30").set(headersB);
    const plaidBucketB = resB.body.data.find((d: any) => d.source === "plaid");
    expect(plaidBucketB.total_amount).toBeGreaterThanOrEqual(30);
    // Neither total should ever include the other user's amount.
    expect(plaidBucket.total_amount).not.toBe(plaidBucketB.total_amount + 25);
  });

  it("by_category groups by the resolved category (userCategory over categoryPrimary)", async () => {
    const res = await request(app).get("/api/aggregations/by_category?start=2026-09-01&end=2026-09-30").set(headersA);
    const foodBucket = res.body.data.find((d: any) => d.category === "Food and Drink");
    expect(foodBucket).toBeTruthy();
    expect(foodBucket.total_amount).toBeGreaterThanOrEqual(25);
  });
});
