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

// ── Fixtures ───────────────────────────────────────────────────────────────

beforeEach(() => {
  reset();
  vi.clearAllMocks();
});

const RECEIPT = {
  id: 10,
  sourceFilePath: "/uploads/receipt.png",
  ocrEngine: "tesseract",
  storeName: "TARGET",
  storeAddress: "123 Main St",
  purchaseDate: "2025-01-10",
  subtotal: 45.0,
  tax: 3.6,
  total: 48.6,
  paymentMethod: "VISA",
  returnWindowDays: 30,
  returnDeadline: "2025-02-09",
  processingStatus: "processed",
  ocrConfidence: 0.92,
  notes: null,
  createdAt: new Date("2025-01-10T10:00:00.000Z"),
  updatedAt: new Date("2025-01-10T10:00:00.000Z"),
};

const ITEM = {
  id: 1,
  receiptId: 10,
  name: "Paper Towels",
  quantity: 2,
  unitPrice: 12.5,
  totalPrice: 25.0,
  sortOrder: 0,
};

// ── GET /api/receipts/expiring ─────────────────────────────────────────────

describe("GET /api/receipts/expiring", () => {
  it("returns 200 with empty array when no receipts expiring", async () => {
    // receipts query returns [] → getMatchMap skips DB call (empty ids)
    enqueue([]);
    const res = await request(app).get("/api/receipts/expiring");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns expiring receipts with match map", async () => {
    // receipts query → getMatchMap query
    enqueue([RECEIPT], [{ receiptId: 10, id: 5 }]);
    const res = await request(app).get("/api/receipts/expiring");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(10);
    expect(res.body[0].matchId).toBe(5);
  });

  it("accepts days query param", async () => {
    enqueue([]);
    const res = await request(app).get("/api/receipts/expiring?days=7");
    expect(res.status).toBe(200);
  });

  it("defaults to 14 days when days param is absent", async () => {
    enqueue([]);
    const res = await request(app).get("/api/receipts/expiring");
    expect(res.status).toBe(200);
  });
});

// ── GET /api/receipts/unmatched ───────────────────────────────────────────

describe("GET /api/receipts/unmatched", () => {
  it("returns 200 with unmatched receipts", async () => {
    // subquery is NOT awaited; only outer select pops queue
    enqueue([RECEIPT]);
    const res = await request(app).get("/api/receipts/unmatched");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(10);
    expect(res.body[0].matchId).toBeNull();
  });

  it("returns empty array when all receipts matched", async () => {
    enqueue([]);
    const res = await request(app).get("/api/receipts/unmatched");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── GET /api/receipts ─────────────────────────────────────────────────────

describe("GET /api/receipts", () => {
  it("returns 200 with list of receipts", async () => {
    enqueue([RECEIPT], []);
    const res = await request(app).get("/api/receipts");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].storeName).toBe("TARGET");
  });

  it("includes all serialized fields", async () => {
    enqueue([RECEIPT], []);
    const res = await request(app).get("/api/receipts");
    const r = res.body[0];
    expect(r).toHaveProperty("id");
    expect(r).toHaveProperty("sourceFilePath");
    expect(r).toHaveProperty("ocrEngine");
    expect(r).toHaveProperty("storeName");
    expect(r).toHaveProperty("purchaseDate");
    expect(r).toHaveProperty("total");
    expect(r).toHaveProperty("processingStatus");
    expect(r).toHaveProperty("matchId");
    expect(r).toHaveProperty("createdAt");
    expect(r).toHaveProperty("updatedAt");
  });

  it("returns empty array when no receipts exist", async () => {
    enqueue([], []);
    const res = await request(app).get("/api/receipts");
    expect(res.body).toEqual([]);
  });

  it("accepts status filter param", async () => {
    enqueue([RECEIPT], []);
    const res = await request(app).get("/api/receipts?status=processed");
    expect(res.status).toBe(200);
  });

  it("accepts search filter param", async () => {
    enqueue([RECEIPT], []);
    const res = await request(app).get("/api/receipts?search=target");
    expect(res.status).toBe(200);
  });

  it("accepts from/to date filter params", async () => {
    enqueue([RECEIPT], []);
    const res = await request(app).get("/api/receipts?from=2025-01-01&to=2025-01-31");
    expect(res.status).toBe(200);
  });
});

// ── POST /api/receipts ────────────────────────────────────────────────────

describe("POST /api/receipts", () => {
  const VALID_BODY = {
    sourceFilePath: "/uploads/r.png",
    ocrEngine: "tesseract",
  };

  it("returns 201 with the created receipt", async () => {
    enqueue([RECEIPT]);
    const res = await request(app).post("/api/receipts").send(VALID_BODY);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(10);
    expect(res.body.processingStatus).toBe("processed");
  });

  it("computes returnDeadline from purchaseDate + returnWindowDays", async () => {
    const body = { ...VALID_BODY, purchaseDate: "2025-01-10", returnWindowDays: 30 };
    const receiptWithDeadline = { ...RECEIPT, returnDeadline: "2025-02-09" };
    enqueue([receiptWithDeadline]);
    const res = await request(app).post("/api/receipts").send(body);
    expect(res.status).toBe(201);
  });

  it("returns 400 when sourceFilePath is missing", async () => {
    const res = await request(app).post("/api/receipts").send({ ocrEngine: "tesseract" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when ocrEngine is missing", async () => {
    const res = await request(app).post("/api/receipts").send({ sourceFilePath: "/file.png" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).post("/api/receipts").send({});
    expect(res.status).toBe(400);
  });
});

// ── GET /api/receipts/:receiptId ──────────────────────────────────────────

describe("GET /api/receipts/:receiptId", () => {
  it("returns 200 with receipt, items, and matchId", async () => {
    // 3 DB calls: receipt, items, match
    enqueue([RECEIPT], [ITEM], [{ id: 7 }]);
    const res = await request(app).get("/api/receipts/10");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(10);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.matchId).toBe(7);
  });

  it("returns items as empty array when none exist", async () => {
    enqueue([RECEIPT], [], []);
    const res = await request(app).get("/api/receipts/10");
    expect(res.body.items).toEqual([]);
    expect(res.body.matchId).toBeNull();
  });

  it("returns 404 when receipt not found", async () => {
    enqueue([]);
    const res = await request(app).get("/api/receipts/999");
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ── PATCH /api/receipts/:receiptId ────────────────────────────────────────

describe("PATCH /api/receipts/:receiptId", () => {
  it("returns 200 with updated receipt", async () => {
    const updated = { ...RECEIPT, storeName: "COSTCO" };
    enqueue([updated], []);
    const res = await request(app)
      .patch("/api/receipts/10")
      .send({ storeName: "COSTCO" });
    expect(res.status).toBe(200);
    expect(res.body.storeName).toBe("COSTCO");
  });

  it("returns 404 when receipt not found during patch", async () => {
    enqueue([]); // update returns nothing
    const res = await request(app).patch("/api/receipts/999").send({ storeName: "X" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when patch body fails Zod validation", async () => {
    const res = await request(app)
      .patch("/api/receipts/10")
      .send({ total: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("accepts partial patch (only notes)", async () => {
    enqueue([{ ...RECEIPT, notes: "updated note" }], []);
    const res = await request(app)
      .patch("/api/receipts/10")
      .send({ notes: "updated note" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("updated note");
  });
});

// ── DELETE /api/receipts/:receiptId ───────────────────────────────────────

describe("DELETE /api/receipts/:receiptId", () => {
  it("returns 204 on deletion", async () => {
    enqueue([]);
    const res = await request(app).delete("/api/receipts/10");
    expect(res.status).toBe(204);
  });

  it("returns 204 for non-existent receipt (idempotent)", async () => {
    enqueue([]);
    const res = await request(app).delete("/api/receipts/999");
    expect(res.status).toBe(204);
  });
});

// ── GET /api/receipts/:receiptId/items ────────────────────────────────────

describe("GET /api/receipts/:receiptId/items", () => {
  it("returns 200 with item list", async () => {
    enqueue([ITEM]);
    const res = await request(app).get("/api/receipts/10/items");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Paper Towels");
  });

  it("returns empty array when receipt has no items", async () => {
    enqueue([]);
    const res = await request(app).get("/api/receipts/10/items");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── POST /api/receipts/:receiptId/items ───────────────────────────────────

describe("POST /api/receipts/:receiptId/items", () => {
    // CreateReceiptItemBody requires: description, quantity, unitPrice, lineTotal
  const VALID_ITEM_BODY = {
    description: "Shampoo",
    quantity: 1,
    unitPrice: 8.99,
    lineTotal: 8.99,
  };

  it("returns 201 with the created item", async () => {
    enqueue([ITEM]);
    const res = await request(app)
      .post("/api/receipts/10/items")
      .send(VALID_ITEM_BODY);
    expect(res.status).toBe(201);
  });

  it("returns 400 when description is missing", async () => {
    const res = await request(app)
      .post("/api/receipts/10/items")
      .send({ quantity: 1, unitPrice: 5.0, lineTotal: 5.0 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app).post("/api/receipts/10/items").send({});
    expect(res.status).toBe(400);
  });
});
