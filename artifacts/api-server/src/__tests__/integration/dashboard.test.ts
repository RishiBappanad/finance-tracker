import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// ── DB mock ────────────────────────────────────────────────────────────────

const { mockDb, enqueue, reset } = vi.hoisted(() => {
  const queue: unknown[] = [];

  const makeChain = () => {
    const c: Record<string, unknown> = {};
    for (const m of [
      "from", "where", "leftJoin", "rightJoin", "orderBy", "limit", "offset",
      "groupBy", "having", "values", "onConflictDoNothing", "onConflictDoUpdate",
      "returning", "set", "execute",
    ]) {
      c[m] = () => c;
    }
    (c as any).then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(res, rej);
    (c as any).catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).catch(rej);
    return c;
  };

  const mockDb = {
    select: () => makeChain(),
    insert: () => makeChain(),
    update: () => makeChain(),
    delete: () => makeChain(),
  };

  return {
    mockDb,
    enqueue: (...vals: unknown[]) => vals.forEach((v) => queue.push(v)),
    reset: () => queue.splice(0, queue.length),
  };
});

vi.mock("@workspace/db", () => ({
  db: mockDb,
  accounts: {},
  institutions: {},
  bankTransactions: {},
  scannedReceipts: {},
  receiptItems: {},
  receiptTransactionMatches: {},
}));

const { default: app } = await import("../../app.js");

// ── Helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

/**
 * GET /summary makes exactly 7 sequential DB calls:
 *  1. totalReceipts       (count from scannedReceipts)
 *  2. matchedReceipts     (count from receiptTransactionMatches)
 *  3. totalTxn            (count from bankTransactions)
 *  4. unmatchedTxn        (count from bankTransactions where NOT IN ...)
 *  5. expiring            (count from scannedReceipts where deadline range)
 *  6. spend               (sum from bankTransactions this month)
 *  7. pendingReconciliation (count from receiptTransactionMatches confirmed=false)
 */
function enqueueSummary({
  totalReceipts = 5,
  matchedReceipts = 3,
  totalTxn = 20,
  unmatchedTxn = 10,
  expiring = 2,
  spend = 450.75,
  pending = 1,
} = {}) {
  enqueue(
    [{ count: totalReceipts }],
    [{ count: matchedReceipts }],
    [{ count: totalTxn }],
    [{ count: unmatchedTxn }],
    [{ count: expiring }],
    [{ total: spend }],
    [{ count: pending }]
  );
}

// ── GET /api/dashboard/summary ────────────────────────────────────────────

describe("GET /api/dashboard/summary", () => {
  it("returns 200 with all summary fields", async () => {
    enqueueSummary();
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toHaveProperty("totalReceipts");
    expect(body).toHaveProperty("matchedReceipts");
    expect(body).toHaveProperty("unmatchedReceipts");
    expect(body).toHaveProperty("totalTransactions");
    expect(body).toHaveProperty("unmatchedTransactions");
    expect(body).toHaveProperty("expiringReturns");
    expect(body).toHaveProperty("totalSpendThisMonth");
    expect(body).toHaveProperty("pendingReconciliation");
  });

  it("computes unmatchedReceipts as totalReceipts - matchedReceipts", async () => {
    enqueueSummary({ totalReceipts: 10, matchedReceipts: 6 });
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.body.unmatchedReceipts).toBe(4);
  });

  it("returns correct counts from DB rows", async () => {
    enqueueSummary({
      totalReceipts: 8,
      matchedReceipts: 5,
      totalTxn: 30,
      unmatchedTxn: 12,
      expiring: 3,
      spend: 999.99,
      pending: 7,
    });
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.body.totalReceipts).toBe(8);
    expect(res.body.matchedReceipts).toBe(5);
    expect(res.body.totalTransactions).toBe(30);
    expect(res.body.unmatchedTransactions).toBe(12);
    expect(res.body.expiringReturns).toBe(3);
    expect(res.body.totalSpendThisMonth).toBe(999.99);
    expect(res.body.pendingReconciliation).toBe(7);
  });

  it("defaults to 0 when DB rows are missing fields (null coalesce)", async () => {
    // All 7 queries return empty arrays → all fields default to 0
    enqueue([], [], [], [], [], [], []);
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.totalReceipts).toBe(0);
    expect(res.body.matchedReceipts).toBe(0);
    expect(res.body.unmatchedReceipts).toBe(0);
    expect(res.body.totalTransactions).toBe(0);
    expect(res.body.unmatchedTransactions).toBe(0);
    expect(res.body.expiringReturns).toBe(0);
    expect(res.body.totalSpendThisMonth).toBe(0);
    expect(res.body.pendingReconciliation).toBe(0);
  });

  it("handles zero receipts and transactions gracefully", async () => {
    enqueueSummary({ totalReceipts: 0, matchedReceipts: 0, totalTxn: 0, unmatchedTxn: 0 });
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.body.unmatchedReceipts).toBe(0);
  });

  it("returns JSON content-type", async () => {
    enqueueSummary();
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });
});

// ── GET /api/dashboard/spending-by-category ───────────────────────────────

describe("GET /api/dashboard/spending-by-category", () => {
  const SPENDING_ROWS = [
    { category: "Food", total: 240.5, count: 12 },
    { category: "Transport", total: 85.0, count: 5 },
    { category: "Uncategorized", total: 30.0, count: 2 },
  ];

  it("returns 200 with spending by category", async () => {
    enqueue(SPENDING_ROWS);
    const res = await request(app).get("/api/dashboard/spending-by-category");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });

  it("returns correct category data shape", async () => {
    enqueue(SPENDING_ROWS);
    const res = await request(app).get("/api/dashboard/spending-by-category");
    const food = res.body.find((r: any) => r.category === "Food");
    expect(food.total).toBe(240.5);
    expect(food.count).toBe(12);
  });

  it("returns empty array when no transactions exist", async () => {
    enqueue([]);
    const res = await request(app).get("/api/dashboard/spending-by-category");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("accepts from query param without error", async () => {
    enqueue(SPENDING_ROWS);
    const res = await request(app).get(
      "/api/dashboard/spending-by-category?from=2025-01-01"
    );
    expect(res.status).toBe(200);
  });

  it("accepts to query param without error", async () => {
    enqueue([]);
    const res = await request(app).get(
      "/api/dashboard/spending-by-category?to=2025-12-31"
    );
    expect(res.status).toBe(200);
  });

  it("accepts both from and to query params", async () => {
    enqueue(SPENDING_ROWS);
    const res = await request(app).get(
      "/api/dashboard/spending-by-category?from=2025-01-01&to=2025-01-31"
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
  });
});
