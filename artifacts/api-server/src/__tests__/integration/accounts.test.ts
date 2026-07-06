import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// ── DB mock (must be hoisted before any import that resolves @workspace/db) ──

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

// ── App (imported after mocks are set up) ─────────────────────────────────

const { default: app } = await import("../../app.js");

// ── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

const ACCOUNT_ROW = {
  id: "acc-1",
  institutionId: "inst-1",
  institutionName: "Chase",
  name: "Checking",
  type: "depository",
  subtype: "checking",
  mask: "1234",
  currency: "USD",
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};

describe("GET /api/accounts", () => {
  it("returns 200 with account list", async () => {
    enqueue([ACCOUNT_ROW]);
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("acc-1");
    expect(res.body[0].institutionName).toBe("Chase");
  });

  it("serializes createdAt to ISO string", async () => {
    enqueue([ACCOUNT_ROW]);
    const res = await request(app).get("/api/accounts");
    expect(typeof res.body[0].createdAt).toBe("string");
    expect(res.body[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns empty array when no accounts exist", async () => {
    enqueue([]);
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("GET /api/accounts/:accountId", () => {
  it("returns 200 with account when found", async () => {
    enqueue([ACCOUNT_ROW]);
    const res = await request(app).get("/api/accounts/acc-1");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("acc-1");
    expect(res.body.name).toBe("Checking");
  });

  it("returns 404 when account not found", async () => {
    enqueue([]);
    const res = await request(app).get("/api/accounts/nonexistent");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("serializes createdAt to ISO string on single-account response", async () => {
    enqueue([ACCOUNT_ROW]);
    const res = await request(app).get("/api/accounts/acc-1");
    expect(typeof res.body.createdAt).toBe("string");
  });
});

describe("POST /api/accounts", () => {
  const VALID_BODY = {
    publicToken: "public-token-abc",
    institutionId: "inst-1",
    institutionName: "Chase",
  };

  it("returns 201 with the new account on success", async () => {
    mockPlaid.exchangePublicToken.mockResolvedValue({ accessToken: "access-token" });
    mockPlaid.getAccounts.mockResolvedValue([
      {
        accountId: "acc-new",
        name: "Savings",
        type: "depository",
        subtype: "savings",
        mask: "5678",
        currency: "USD",
      },
    ]);
    // DB calls: insert institution, insert account, select account for response
    enqueue([], [{ id: "acc-new" }], [{ ...ACCOUNT_ROW, id: "acc-new", name: "Savings" }]);

    const res = await request(app).post("/api/accounts").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("acc-new");
  });

  it("returns 400 when Plaid returns no accounts", async () => {
    mockPlaid.exchangePublicToken.mockResolvedValue({ accessToken: "access-token" });
    mockPlaid.getAccounts.mockResolvedValue([]);
    // DB call: insert institution only (before early return)
    enqueue([]);

    const res = await request(app).post("/api/accounts").send(VALID_BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no accounts/i);
  });

  it("returns 400 when request body is missing publicToken", async () => {
    const res = await request(app)
      .post("/api/accounts")
      .send({ institutionId: "inst-1", institutionName: "Chase" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when request body is missing institutionId", async () => {
    const res = await request(app)
      .post("/api/accounts")
      .send({ publicToken: "tok", institutionName: "Chase" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when request body is empty", async () => {
    const res = await request(app).post("/api/accounts").send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/accounts/:accountId", () => {
  it("returns 204 on successful deletion", async () => {
    enqueue([]);
    const res = await request(app).delete("/api/accounts/acc-1");
    expect(res.status).toBe(204);
    expect(res.text).toBe("");
  });

  it("returns 204 even for non-existent account (idempotent delete)", async () => {
    enqueue([]);
    const res = await request(app).delete("/api/accounts/ghost");
    expect(res.status).toBe(204);
  });
});
