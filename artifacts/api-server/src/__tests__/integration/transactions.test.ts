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

// ── Plaid mock ─────────────────────────────────────────────────────────────

const mockPlaid = vi.hoisted(() => ({
  exchangePublicToken: vi.fn(),
  getAccounts: vi.fn(),
  syncTransactions: vi.fn(),
  name: "mock",
}));

vi.mock("../../services/plaid.js", () => ({
  getPlaidAdapter: () => mockPlaid,
}));

const { default: app } = await import("../../app.js");

// ── Fixtures ───────────────────────────────────────────────────────────────

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

const TXN = {
  id: "txn-1",
  accountId: "acc-1",
  amount: 42.5,
  currency: "USD",
  merchantName: "WHOLE FOODS",
  merchantNameRaw: "WHOLE FOODS MKT #123",
  categoryPrimary: "Food",
  categoryDetail: "Groceries",
  date: "2025-01-10",
  pending: false,
  createdAt: new Date("2025-01-10T12:00:00.000Z"),
};

// ── GET /api/transactions/unmatched ───────────────────────────────────────

describe("GET /api/transactions/unmatched", () => {
  it("returns 200 with unmatched transactions", async () => {
    // Only the outer (awaited) select pops the queue; the inner subquery select is not awaited
    enqueue([TXN]);
    const res = await request(app).get("/api/transactions/unmatched");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("txn-1");
  });

  it("returns empty array when all transactions are matched", async () => {
    enqueue([]);
    const res = await request(app).get("/api/transactions/unmatched");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("serializes createdAt to ISO string", async () => {
    enqueue([TXN]);
    const res = await request(app).get("/api/transactions/unmatched");
    expect(typeof res.body[0].createdAt).toBe("string");
  });

  it("includes matchId as null for unmatched transactions", async () => {
    enqueue([TXN]);
    const res = await request(app).get("/api/transactions/unmatched");
    expect(res.body[0].matchId).toBeNull();
  });
});

// ── GET /api/transactions ─────────────────────────────────────────────────

describe("GET /api/transactions", () => {
  it("returns 200 with transaction list", async () => {
    enqueue([TXN], []); // transactions, then match rows
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("txn-1");
  });

  it("attaches matchId from the match table", async () => {
    enqueue([TXN], [{ txnId: "txn-1", id: 99 }]);
    const res = await request(app).get("/api/transactions");
    expect(res.body[0].matchId).toBe(99);
  });

  it("returns empty array when no transactions", async () => {
    enqueue([], []);
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("accepts accountId query param without error", async () => {
    enqueue([TXN], []);
    const res = await request(app).get("/api/transactions?accountId=acc-1");
    expect(res.status).toBe(200);
  });

  it("accepts pending=true query param without error", async () => {
    enqueue([], []);
    const res = await request(app).get("/api/transactions?pending=true");
    expect(res.status).toBe(200);
  });

  it("accepts from/to date filter query params", async () => {
    enqueue([TXN], []);
    const res = await request(app).get(
      "/api/transactions?from=2025-01-01&to=2025-01-31"
    );
    expect(res.status).toBe(200);
  });

  it("accepts search query param", async () => {
    enqueue([TXN], []);
    const res = await request(app).get("/api/transactions?search=whole+foods");
    expect(res.status).toBe(200);
  });

  it("includes all serialized fields in response", async () => {
    enqueue([TXN], []);
    const res = await request(app).get("/api/transactions");
    const t = res.body[0];
    expect(t).toHaveProperty("id");
    expect(t).toHaveProperty("accountId");
    expect(t).toHaveProperty("amount");
    expect(t).toHaveProperty("currency");
    expect(t).toHaveProperty("merchantName");
    expect(t).toHaveProperty("date");
    expect(t).toHaveProperty("pending");
    expect(t).toHaveProperty("matchId");
    expect(t).toHaveProperty("createdAt");
  });
});

// ── GET /api/transactions/:transactionId ──────────────────────────────────

describe("GET /api/transactions/:transactionId", () => {
  it("returns 200 with the transaction when found", async () => {
    enqueue([TXN], []); // txn row, then match row
    const res = await request(app).get("/api/transactions/txn-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("txn-1");
    expect(res.body.amount).toBe(42.5);
  });

  it("returns 404 when transaction does not exist", async () => {
    enqueue([]); // empty result → 404
    const res = await request(app).get("/api/transactions/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("includes matchId from match table", async () => {
    enqueue([TXN], [{ id: 77 }]); // txn, then match
    const res = await request(app).get("/api/transactions/txn-1");
    expect(res.body.matchId).toBe(77);
  });

  it("sets matchId to null when no match exists", async () => {
    enqueue([TXN], []); // txn found, no match
    const res = await request(app).get("/api/transactions/txn-1");
    expect(res.body.matchId).toBeNull();
  });
});

// ── POST /api/transactions/sync ───────────────────────────────────────────

describe("POST /api/transactions/sync", () => {
  it("returns 200 with sync summary when no accounts exist", async () => {
    enqueue([]); // no accounts → loop doesn't run
    const res = await request(app).post("/api/transactions/sync");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      added: 0,
      removed: 0,
      updated: 0,
      accounts: 0,
    });
  });

  it("syncs transactions for each account", async () => {
    const mockAccount = { id: "acc-1", accessToken: "mock-token" };
    mockPlaid.syncTransactions.mockResolvedValue({
      added: [
        {
          transactionId: "new-txn-1",
          accountId: "acc-1",
          amount: 19.99,
          isoCurrencyCode: "USD",
          merchantName: "STARBUCKS",
          name: "Starbucks #123",
          category: ["Food", "Coffee"],
          date: "2025-01-10",
          pending: false,
        },
      ],
      modified: [],
      removed: [],
    });
    enqueue([mockAccount]); // accounts query
    enqueue([]); // insert txn (onConflictDoNothing, returns void-ish)

    const res = await request(app).post("/api/transactions/sync");
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.accounts).toBe(1);
  });

  it("reports modified and removed counts from Plaid", async () => {
    const mockAccount = { id: "acc-1" };
    mockPlaid.syncTransactions.mockResolvedValue({
      added: [],
      modified: [{ transactionId: "t1" }, { transactionId: "t2" }],
      removed: ["t3"],
    });
    enqueue([mockAccount]);

    const res = await request(app).post("/api/transactions/sync");
    expect(res.body.updated).toBe(2);
    expect(res.body.removed).toBe(1);
  });

  it("continues gracefully when a per-account sync fails", async () => {
    const accounts = [{ id: "acc-1" }, { id: "acc-2" }];
    mockPlaid.syncTransactions
      .mockRejectedValueOnce(new Error("Plaid error"))
      .mockResolvedValueOnce({ added: [], modified: [], removed: [] });
    enqueue(accounts);

    const res = await request(app).post("/api/transactions/sync");
    expect(res.status).toBe(200);
    // Both accounts attempted; first fails gracefully
    expect(res.body.accounts).toBe(2);
  });
});
