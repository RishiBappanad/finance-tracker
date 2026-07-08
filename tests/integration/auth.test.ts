import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

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
  scannedReceipts: {},
  receiptItems: {},
  receiptTransactionMatches: {},
  userCategories: {},
}));

import app from "../../artifacts/api-server/src/app.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-for-jwt-signing";

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => reset());

describe("POST /api/auth/register", () => {
  it("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ password: "secure123" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "test@example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it("returns 400 when password is too short", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "test@example.com", password: "12345" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/6 characters/i);
  });

  it("returns 409 when email already exists", async () => {
    // First query: check if email exists → returns existing user
    enqueue([{ id: 1, email: "taken@example.com" }]);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "taken@example.com", password: "secure123" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already registered/i);
  });

  it("returns 201 with token and user on success", async () => {
    // First query: check existing → empty
    enqueue([]);
    // Second: insert → returning user
    enqueue([{ id: 5, email: "new@example.com", name: "New User" }]);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "new@example.com", password: "secure123", name: "New User" });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.email).toBe("new@example.com");
    expect(res.body.user.name).toBe("New User");
    expect(res.body.user.id).toBe(5);

    // Verify token is valid
    const decoded = jwt.verify(res.body.token, JWT_SECRET) as any;
    expect(decoded.userId).toBe(5);
    expect(decoded.email).toBe("new@example.com");
  });

  it("normalizes email to lowercase", async () => {
    enqueue([]);
    enqueue([{ id: 1, email: "upper@example.com", name: null }]);

    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: "UPPER@EXAMPLE.COM", password: "secure123" });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("upper@example.com");
  });
});

describe("POST /api/auth/login", () => {
  it("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ password: "secure123" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "test@example.com" });
    expect(res.status).toBe(400);
  });

  it("returns 401 when user not found", async () => {
    enqueue([]); // No user found
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "anything" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 401 when password is wrong", async () => {
    const hash = await bcrypt.hash("correctpassword", 4);
    enqueue([{ id: 1, email: "user@test.com", passwordHash: hash, name: "User" }]);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "wrongpassword" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 200 with token on correct credentials", async () => {
    const hash = await bcrypt.hash("mypassword", 4);
    enqueue([{ id: 3, email: "user@test.com", passwordHash: hash, name: "Test" }]);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@test.com", password: "mypassword" });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.id).toBe(3);
    expect(res.body.user.email).toBe("user@test.com");
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", "Bearer invalid-garbage-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const expired = jwt.sign({ userId: 1, email: "x@x.com" }, JWT_SECRET, { expiresIn: "-1s" });
    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("returns user info with valid token", async () => {
    const token = jwt.sign({ userId: 7, email: "me@test.com" }, JWT_SECRET, { expiresIn: "1h" });
    enqueue([{ id: 7, email: "me@test.com", name: "Me" }]);

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(7);
    expect(res.body.email).toBe("me@test.com");
  });
});

describe("Auth middleware on protected routes", () => {
  it("returns 401 for /api/accounts without token", async () => {
    const res = await request(app).get("/api/accounts");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/transactions without token", async () => {
    const res = await request(app).get("/api/transactions");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/receipts without token", async () => {
    const res = await request(app).get("/api/receipts");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/dashboard/summary without token", async () => {
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/categories without token", async () => {
    const res = await request(app).get("/api/categories");
    expect(res.status).toBe(401);
  });

  it("allows /api/healthz without token (public)", async () => {
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
