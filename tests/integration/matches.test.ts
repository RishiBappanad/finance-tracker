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

const MATCH = {
  id: 1,
  receiptId: 10,
  bankTransactionId: "txn-1",
  matchMethod: "auto",
  confidenceScore: 0.95,
  scoreBreakdown: JSON.stringify({ amount: 1.0, date: 1.0, merchant: 0.8 }),
  confirmed: false,
  confirmedAt: null,
  createdAt: new Date("2025-01-10T10:00:00.000Z"),
};

// ── POST /api/reconcile/run ───────────────────────────────────────────────

describe("POST /api/reconcile/run", () => {
  it("returns 200 with auto_matched when receipt and txn align perfectly", async () => {
    const receipt = {
      id: 10,
      total: 50.0,
      purchaseDate: "2025-01-10",
      storeName: "TARGET",
      processingStatus: "processed",
    };
    const txn = {
      id: "txn-1",
      amount: 50.0,
      date: "2025-01-10",
      merchantName: "TARGET",
    };

    enqueue([]); // requireAuth's ensureLocalUser insert
    // unmatched receipts, unmatched txns, then insert for auto_match
    enqueue([receipt], [txn], [MATCH]);

    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    expect(res.status).toBe(200);
    expect(res.body.autoMatched).toBe(1);
    expect(res.body.needsReview).toBe(0);
    expect(res.body.unmatched).toBe(0);
    expect(res.body.matches).toHaveLength(1);
  });

  it("returns needs_review for partial matches", async () => {
    const receipt = {
      id: 11,
      total: 50.0,
      purchaseDate: "2025-01-10",
      storeName: null,
      processingStatus: "processed",
    };
    // No merchant → composite ≈ 0.75 → needs_review; no insert
    const txn = { id: "txn-2", amount: 50.0, date: "2025-01-10", merchantName: null };
    enqueue([]);
    enqueue([receipt], [txn]);

    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    expect(res.status).toBe(200);
    expect(res.body.needsReview).toBe(1);
    expect(res.body.autoMatched).toBe(0);
  });

  it("returns unmatched for receipt with null total", async () => {
    const receipt = { id: 12, total: null, purchaseDate: "2025-01-10", storeName: null };
    enqueue([]);
    enqueue([receipt], []);

    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    expect(res.body.unmatched).toBe(1);
    expect(res.body.autoMatched).toBe(0);
  });

  it("returns unmatched for receipt with null purchaseDate", async () => {
    const receipt = { id: 13, total: 50.0, purchaseDate: null, storeName: "SHOP" };
    enqueue([]);
    enqueue([receipt], []);

    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    expect(res.body.unmatched).toBe(1);
  });

  it("returns 200 with zeros when no unmatched data exists", async () => {
    enqueue([]);
    enqueue([], []); // no receipts, no txns
    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoMatched: 0, needsReview: 0, unmatched: 0, matches: [] });
  });

  it("prevents double-matching (removes txn from pool after auto_match)", async () => {
    const receipts = [
      { id: 10, total: 50.0, purchaseDate: "2025-01-10", storeName: "TARGET" },
      { id: 11, total: 50.0, purchaseDate: "2025-01-10", storeName: "TARGET" },
    ];
    const txn = { id: "txn-1", amount: 50.0, date: "2025-01-10", merchantName: "TARGET" };

    enqueue([]);
    // First receipt auto-matches txn-1; second receipt finds empty pool
    enqueue(receipts, [txn], [MATCH]);

    const res = await request(app).post("/api/reconcile/run").set(authHeader(userA));
    // txn-1 consumed by first; second → unmatched (no candidates)
    expect(res.body.autoMatched).toBe(1);
    expect(res.body.unmatched).toBe(1);
  });

  it("returns 401 without auth", async () => {
    const res = await request(app).post("/api/reconcile/run");
    expect(res.status).toBe(401);
  });
});

// ── GET /api/matches ──────────────────────────────────────────────────────

describe("GET /api/matches", () => {
  it("returns 200 with list of matches", async () => {
    enqueue([]);
    enqueue([MATCH]);
    const res = await request(app).get("/api/matches").set(authHeader(userA));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
    expect(res.body[0].receiptId).toBe(10);
  });

  it("parses scoreBreakdown JSON string to object", async () => {
    enqueue([]);
    enqueue([MATCH]);
    const res = await request(app).get("/api/matches").set(authHeader(userA));
    const breakdown = res.body[0].scoreBreakdown;
    expect(typeof breakdown).toBe("object");
    expect(breakdown.amount).toBe(1.0);
  });

  it("returns empty array when no matches exist", async () => {
    enqueue([]);
    enqueue([]);
    const res = await request(app).get("/api/matches").set(authHeader(userA));
    expect(res.body).toEqual([]);
  });

  it("accepts confirmed filter param", async () => {
    enqueue([]);
    enqueue([]);
    const res = await request(app).get("/api/matches?confirmed=true").set(authHeader(userA));
    expect(res.status).toBe(200);
  });

  it("accepts confirmed=false filter param", async () => {
    enqueue([]);
    enqueue([MATCH]);
    const res = await request(app).get("/api/matches?confirmed=false").set(authHeader(userA));
    expect(res.status).toBe(200);
  });
});

// ── POST /api/matches ─────────────────────────────────────────────────────

describe("POST /api/matches", () => {
  const VALID_BODY = { receiptId: 10, bankTransactionId: "txn-1" };

  it("returns 201 with the created match", async () => {
    enqueue([]);
    enqueue([MATCH]);
    const res = await request(app).post("/api/matches").set(authHeader(userA)).send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.receiptId).toBe(10);
    expect(res.body.bankTransactionId).toBe("txn-1");
    expect(res.body.matchMethod).toBe("auto"); // from fixture
  });

  it("returns 400 when receiptId is missing", async () => {
    enqueue([]);
    const res = await request(app)
      .post("/api/matches")
      .set(authHeader(userA))
      .send({ bankTransactionId: "txn-1" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when bankTransactionId is missing", async () => {
    enqueue([]);
    const res = await request(app)
      .post("/api/matches")
      .set(authHeader(userA))
      .send({ receiptId: 10 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    enqueue([]);
    const res = await request(app).post("/api/matches").set(authHeader(userA)).send({});
    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/matches/:matchId ────────────────────────────────────────────

describe("PATCH /api/matches/:matchId", () => {
  it("returns 200 with updated match when confirming", async () => {
    const confirmed = { ...MATCH, confirmed: true, confirmedAt: new Date() };
    enqueue([]);
    enqueue([confirmed]);
    const res = await request(app).patch("/api/matches/1").set(authHeader(userA)).send({ confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(true);
  });

  it("returns 200 when un-confirming a match", async () => {
    enqueue([]);
    enqueue([MATCH]);
    const res = await request(app).patch("/api/matches/1").set(authHeader(userA)).send({ confirmed: false });
    expect(res.status).toBe(200);
  });

  it("returns 404 when match not found", async () => {
    enqueue([]);
    enqueue([]);
    const res = await request(app).patch("/api/matches/9999").set(authHeader(userA)).send({ confirmed: true });
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when body is invalid", async () => {
    enqueue([]);
    const res = await request(app)
      .patch("/api/matches/1")
      .set(authHeader(userA))
      .send({ confirmed: "not-a-boolean" });
    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/matches/:matchId ──────────────────────────────────────────

describe("DELETE /api/matches/:matchId", () => {
  it("returns 204 on successful deletion", async () => {
    enqueue([]);
    enqueue([]);
    const res = await request(app).delete("/api/matches/1").set(authHeader(userA));
    expect(res.status).toBe(204);
  });

  it("returns 204 for non-existent match (idempotent)", async () => {
    enqueue([]);
    enqueue([]);
    const res = await request(app).delete("/api/matches/9999").set(authHeader(userA));
    expect(res.status).toBe(204);
  });
});
