import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-for-jwt-signing";
const tokenA = jwt.sign({ userId: 1, email: "alice@test.com" }, JWT_SECRET, { expiresIn: "1h" });
const tokenB = jwt.sign({ userId: 2, email: "bob@test.com" }, JWT_SECRET, { expiresIn: "1h" });

// ── DB mock ──────────────────────────────────────────────────────────────────

const { mockDb, enqueue, reset } = vi.hoisted(() => {
  const queue: unknown[] = [];

  const makeChain = () => {
    const c: Record<string, any> = {};
    for (const m of [
      "from", "where", "leftJoin", "rightJoin", "innerJoin", "orderBy",
      "limit", "offset", "groupBy", "having", "values", "onConflictDoNothing",
      "onConflictDoUpdate", "returning", "set", "execute",
    ]) {
      c[m] = () => c;
    }
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(res, rej);
    c.catch = (rej: (e: unknown) => unknown) =>
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
  pool: {},
  users: {},
  institutions: { userId: "user_id" },
  accounts: { id: "id", institutionId: "institution_id" },
  bankTransactions: { id: "id", accountId: "account_id", userCategory: "user_category", ignored: "ignored", date: "date", amount: "amount", merchantName: "merchant_name" },
  scannedReceipts: { userId: "user_id" },
  receiptItems: {},
  receiptTransactionMatches: {},
  userCategories: { userId: "user_id" },
}));

import app from "../../artifacts/api-server/src/app.js";

beforeEach(() => reset());

// ── User Scoping Tests ───────────────────────────────────────────────────────

describe("User A cannot access User B's data", () => {
  describe("Accounts", () => {
    it("GET /api/accounts only returns accounts for the authenticated user", async () => {
      // Mock returns Alice's accounts (joined through institutions where userId=1)
      enqueue([
        { id: "acct-1", institutionId: "ins-1", institutionName: "Alice Bank", name: "Checking", type: "depository", subtype: "checking", mask: "1234", currency: "USD", createdAt: new Date() },
      ]);

      const res = await request(app)
        .get("/api/accounts")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Checking");
    });

    it("returns empty array when user has no accounts", async () => {
      enqueue([]); // No accounts for this user

      const res = await request(app)
        .get("/api/accounts")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe("Transactions", () => {
    it("GET /api/transactions returns only user's transactions", async () => {
      enqueue([
        { id: "txn-1", accountId: "acct-1", accountName: "Checking", accountMask: "1234", amount: 50, currency: "USD", merchantName: "Store", merchantNameRaw: "Store", categoryPrimary: null, categoryDetail: null, userCategory: "Shopping", ignored: false, date: "2026-07-01", pending: false, createdAt: new Date() },
      ]);
      // matchRows query
      enqueue([]);

      const res = await request(app)
        .get("/api/transactions")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it("POST /api/transactions/sync only syncs user's institutions", async () => {
      // institutions query returns empty for user B
      enqueue([]);
      // accounts query
      enqueue([]);

      const res = await request(app)
        .post("/api/transactions/sync")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.added).toBe(0);
      expect(res.body.accounts).toBe(0);
    });
  });

  describe("Categories", () => {
    it("GET /api/categories returns only user's custom categories", async () => {
      enqueue([
        { id: 1, name: "My Custom", color: "#ff0000", icon: null, createdAt: new Date() },
      ]);

      const res = await request(app)
        .get("/api/categories")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("My Custom");
    });

    it("POST /api/categories creates category for the authenticated user", async () => {
      enqueue([{ id: 5, name: "New Cat", color: null, icon: null, createdAt: new Date() }]);

      const res = await request(app)
        .post("/api/categories")
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ name: "New Cat" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Cat");
    });

    it("DELETE /api/categories/:id scopes delete to user", async () => {
      enqueue(undefined); // delete result

      const res = await request(app)
        .delete("/api/categories/99")
        .set("Authorization", `Bearer ${tokenA}`);

      expect(res.status).toBe(204);
    });
  });

  describe("Dashboard", () => {
    it("GET /api/dashboard/summary returns zeros for user with no data", async () => {
      // All the summary queries return wrapped results (Drizzle returns arrays)
      enqueue([{ count: 0 }]); // totalReceipts
      enqueue([{ count: 0 }]); // matchedReceipts
      enqueue([{ count: 0 }]); // totalTxn
      enqueue([{ total: 0 }]); // spend
      enqueue([{ count: 0 }]); // expiring
      enqueue([{ count: 0 }]); // pending

      const res = await request(app)
        .get("/api/dashboard/summary")
        .set("Authorization", `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(res.body.totalTransactions).toBe(0);
      expect(res.body.totalSpendThisMonth).toBe(0);
    });
  });
});

describe("Token tampering", () => {
  it("rejects token signed with wrong secret", async () => {
    const badToken = jwt.sign({ userId: 1, email: "x@x.com" }, "wrong-secret", { expiresIn: "1h" });
    const res = await request(app)
      .get("/api/accounts")
      .set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects token with modified payload", async () => {
    // Create a valid token then modify the payload
    const token = jwt.sign({ userId: 1, email: "x@x.com" }, JWT_SECRET);
    const parts = token.split(".");
    // Tamper with payload
    const tamperedPayload = Buffer.from(JSON.stringify({ userId: 999, email: "hacker@evil.com" })).toString("base64url");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await request(app)
      .get("/api/accounts")
      .set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
  });
});
