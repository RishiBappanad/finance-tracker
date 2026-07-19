import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { enqueue, resetQueue, getDbMock } from "../helpers/db-mock.js";
import { authHeader, userA } from "../helpers/auth.js";

vi.mock("@workspace/db", () => getDbMock());

const { default: app } = await import("../../artifacts/api-server/src/app.js");

beforeEach(() => {
  resetQueue();
  vi.clearAllMocks();
});

/**
 * GET /summary makes exactly 6 sequential DB calls (after requireAuth's own
 * ensureLocalUser insert):
 *  1. totalReceipts       (count from scannedReceipts)
 *  2. matchedReceipts     (count from receiptTransactionMatches)
 *  3. totalTxn            (count from bankTransactions)
 *  4. spend               (sum from bankTransactions this month)
 *  5. expiring            (count from scannedReceipts where deadline range)
 *  6. pendingReconciliation (count from receiptTransactionMatches confirmed=false)
 *
 * Note: there is no unmatchedTransactions field/query — the response only
 * derives unmatchedReceipts (totalReceipts - matchedReceipts).
 */
function enqueueSummary({
  totalReceipts = 5,
  matchedReceipts = 3,
  totalTxn = 20,
  expiring = 2,
  spend = 450.75,
  pending = 1,
} = {}) {
  enqueue([]); // requireAuth's ensureLocalUser insert
  enqueue(
    [{ count: totalReceipts }],
    [{ count: matchedReceipts }],
    [{ count: totalTxn }],
    [{ total: spend }],
    [{ count: expiring }],
    [{ count: pending }]
  );
}

describe("GET /api/dashboard/summary", () => {
  it("returns 200 with all summary fields", async () => {
    enqueueSummary();
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toHaveProperty("totalReceipts");
    expect(body).toHaveProperty("matchedReceipts");
    expect(body).toHaveProperty("unmatchedReceipts");
    expect(body).toHaveProperty("totalTransactions");
    expect(body).toHaveProperty("expiringReturns");
    expect(body).toHaveProperty("totalSpendThisMonth");
    expect(body).toHaveProperty("pendingReconciliation");
  });

  it("computes unmatchedReceipts as totalReceipts - matchedReceipts", async () => {
    enqueueSummary({ totalReceipts: 10, matchedReceipts: 6 });
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.body.unmatchedReceipts).toBe(4);
  });

  it("returns correct counts from DB rows", async () => {
    enqueueSummary({
      totalReceipts: 8,
      matchedReceipts: 5,
      totalTxn: 30,
      expiring: 3,
      spend: 999.99,
      pending: 7,
    });
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.body.totalReceipts).toBe(8);
    expect(res.body.matchedReceipts).toBe(5);
    expect(res.body.totalTransactions).toBe(30);
    expect(res.body.expiringReturns).toBe(3);
    expect(res.body.totalSpendThisMonth).toBe(999.99);
    expect(res.body.pendingReconciliation).toBe(7);
  });

  it("defaults to 0 when DB rows are missing fields (null coalesce)", async () => {
    enqueue([]); // requireAuth's ensureLocalUser insert
    // All 6 summary queries return empty arrays → all fields default to 0
    enqueue([], [], [], [], [], []);
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.status).toBe(200);
    expect(res.body.totalReceipts).toBe(0);
    expect(res.body.matchedReceipts).toBe(0);
    expect(res.body.unmatchedReceipts).toBe(0);
    expect(res.body.totalTransactions).toBe(0);
    expect(res.body.expiringReturns).toBe(0);
    expect(res.body.totalSpendThisMonth).toBe(0);
    expect(res.body.pendingReconciliation).toBe(0);
  });

  it("handles zero receipts and transactions gracefully", async () => {
    enqueueSummary({ totalReceipts: 0, matchedReceipts: 0, totalTxn: 0 });
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.body.unmatchedReceipts).toBe(0);
  });

  it("returns JSON content-type", async () => {
    enqueueSummary();
    const res = await request(app).get("/api/dashboard/summary").set(authHeader(userA));
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(401);
  });
});
