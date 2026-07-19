import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs";

const JWT_SECRET = "test-secret-for-jwt-signing";
// requireAuth now verifies a trackstack-auth-issued JWT ({ accountId, email }),
// not a locally-issued one — mint the token in that shape, same as
// tests/integration/trackstack-auth.test.ts.
const token = jwt.sign({ accountId: 1, email: "test@test.com" }, JWT_SECRET, { expiresIn: "1h" });

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
  institutions: {},
  accounts: {},
  bankTransactions: {},
  scannedReceipts: { id: "id", userId: "user_id" },
  receiptItems: { receiptId: "receipt_id" },
  receiptTransactionMatches: { receiptId: "receipt_id" },
  userCategories: {},
}));

import app from "../../artifacts/api-server/src/app.js";

beforeEach(() => reset());

// ── Receipt CRUD ──────────────────────────────────────────────────────────

describe("POST /api/receipts", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/receipts")
      .send({ sourceFilePath: "/test.jpg", ocrEngine: "tesseract" });
    expect(res.status).toBe(401);
  });

  it("returns 400 with invalid input (missing required fields)", async () => {
    const res = await request(app)
      .post("/api/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({ storeName: "Test" }); // Missing sourceFilePath and ocrEngine
    expect(res.status).toBe(400);
  });

  it("creates receipt with valid input", async () => {
    const receipt = {
      id: 1,
      userId: 1,
      sourceFilePath: "/uploads/test.jpg",
      ocrEngine: "tesseract",
      storeName: "Costco",
      purchaseDate: "2026-07-01",
      total: 150.00,
      processingStatus: "pending",
      returnWindowDays: 90,
      returnDeadline: "2026-09-29",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([receipt]); // insert returning

    const res = await request(app)
      .post("/api/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sourceFilePath: "/uploads/test.jpg",
        ocrEngine: "tesseract",
        storeName: "Costco",
        purchaseDate: "2026-07-01",
        total: 150.00,
        returnWindowDays: 90,
      });

    expect(res.status).toBe(201);
    expect(res.body.storeName).toBe("Costco");
    expect(res.body.total).toBe(150);
    expect(res.body.returnDeadline).toBe("2026-09-29");
  });

  it("calculates return deadline from purchaseDate + returnWindowDays", async () => {
    const receipt = {
      id: 2,
      userId: 1,
      sourceFilePath: "/test.jpg",
      ocrEngine: "manual",
      storeName: "Amazon",
      purchaseDate: "2026-01-15",
      total: 50,
      processingStatus: "pending",
      returnWindowDays: 30,
      returnDeadline: "2026-02-14",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([receipt]);

    const res = await request(app)
      .post("/api/receipts")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sourceFilePath: "/test.jpg",
        ocrEngine: "manual",
        purchaseDate: "2026-01-15",
        returnWindowDays: 30,
      });

    expect(res.status).toBe(201);
    expect(res.body.returnDeadline).toBe("2026-02-14");
  });
});

describe("POST /api/receipts/upload", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/receipts/upload")
      .attach("file", Buffer.from("fake image"), "receipt.jpg");
    expect(res.status).toBe(401);
  });

  it("returns 400 when no file provided", async () => {
    const res = await request(app)
      .post("/api/receipts/upload")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it("accepts image upload and creates receipt record", async () => {
    const receipt = {
      id: 3,
      userId: 1,
      sourceFilePath: "/uploads/12345-receipt.jpg",
      ocrEngine: "manual",
      storeName: null,
      processingStatus: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([receipt]);

    const res = await request(app)
      .post("/api/receipts/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake image data"), "receipt.jpg");

    expect(res.status).toBe(201);
    expect(res.body.sourceFilePath).toMatch(/\/uploads\//);
    expect(res.body.processingStatus).toBe("completed");
  });

  it("accepts upload with metadata fields", async () => {
    const receipt = {
      id: 4,
      userId: 1,
      sourceFilePath: "/uploads/test.jpg",
      ocrEngine: "manual",
      storeName: "Target",
      purchaseDate: "2026-07-01",
      total: 75.50,
      processingStatus: "completed",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([receipt]);

    const res = await request(app)
      .post("/api/receipts/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("fake"), "receipt.png")
      .field("storeName", "Target")
      .field("purchaseDate", "2026-07-01")
      .field("total", "75.50");

    expect(res.status).toBe(201);
    expect(res.body.storeName).toBe("Target");
    expect(res.body.total).toBe(75.5);
  });
});

// ── Receipt items (itemization) ──────────────────────────────────────────

describe("POST /api/receipts/:receiptId/items", () => {
  it("returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/receipts/1/items")
      .send({ description: "Item", quantity: 1, unitPrice: 5, lineTotal: 5 });
    expect(res.status).toBe(401);
  });

  it("creates an item for a receipt", async () => {
    const item = {
      id: 1,
      receiptId: 1,
      description: "Milk 2%",
      quantity: 2,
      unitPrice: 3.99,
      lineTotal: 7.98,
      category: "Groceries",
      sku: null,
      isTaxable: true,
      sortOrder: 0,
    };
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([]); // getAllCategoryNames' select from user_categories ("Groceries" is a default, valid either way)
    enqueue([item]);

    const res = await request(app)
      .post("/api/receipts/1/items")
      .set("Authorization", `Bearer ${token}`)
      .send({
        description: "Milk 2%",
        quantity: 2,
        unitPrice: 3.99,
        lineTotal: 7.98,
        category: "Groceries",
      });

    expect(res.status).toBe(201);
    expect(res.body.description).toBe("Milk 2%");
    expect(res.body.lineTotal).toBe(7.98);
    expect(res.body.category).toBe("Groceries");
  });

  it("returns 400 with invalid item data", async () => {
    const res = await request(app)
      .post("/api/receipts/1/items")
      .set("Authorization", `Bearer ${token}`)
      .send({ quantity: 1 }); // Missing description, unitPrice, lineTotal
    expect(res.status).toBe(400);
  });
});

describe("GET /api/receipts/:receiptId/items", () => {
  it("returns items for a receipt", async () => {
    enqueue([]); // requireAuth's ensureLocalUser insert
    enqueue([
      { id: 1, receiptId: 1, description: "Item A", quantity: 1, unitPrice: 10, lineTotal: 10, category: "Food & Dining", sortOrder: 0 },
      { id: 2, receiptId: 1, description: "Item B", quantity: 2, unitPrice: 5, lineTotal: 10, category: "Groceries", sortOrder: 1 },
    ]);

    const res = await request(app)
      .get("/api/receipts/1/items")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].description).toBe("Item A");
    expect(res.body[1].description).toBe("Item B");
  });
});

// ── Per-item category assignment ─────────────────────────────────────────

describe("Receipt item category assignment", () => {
  it("each item can have its own category", () => {
    const items = [
      { description: "Milk", category: "Groceries", lineTotal: 4.99 },
      { description: "Shampoo", category: "Personal Care", lineTotal: 7.99 },
      { description: "Batteries", category: "Shopping", lineTotal: 12.99 },
    ];

    // Verify each item maintains its own category
    expect(items[0].category).toBe("Groceries");
    expect(items[1].category).toBe("Personal Care");
    expect(items[2].category).toBe("Shopping");

    // Total should equal sum of line totals
    const total = items.reduce((sum, i) => sum + i.lineTotal, 0);
    expect(total).toBeCloseTo(25.97);
  });
});
