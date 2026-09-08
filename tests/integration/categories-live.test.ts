import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { db, userCategories } from "@workspace/db";
import { eq } from "drizzle-orm";

// Live-database test for the category color-override feature
// (routes/categories.ts) -- covers two things a mock can't: the real
// user_categories_user_id_name_unique constraint the PUT /categories/color
// upsert depends on (onConflictDoUpdate needs a real constraint to target,
// not just app-level duplicate checking), and cross-user isolation on
// GET /categories.
//
// Run via: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const A_ID = 920_000_000 + (RUN % 90_000_000);
const B_ID = A_ID + 1;

function authHeader(accountId: number, email: string) {
  const token = jwt.sign({ accountId, email }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const userA = { id: A_ID, email: `categories-live-test-a-${RUN}@test.trackstack.invalid` };
const userB = { id: B_ID, email: `categories-live-test-b-${RUN}@test.trackstack.invalid` };
const headersA = authHeader(userA.id, userA.email);
const headersB = authHeader(userB.id, userB.email);

const customCategoryName = `Custom Test Cat ${RUN}`;

afterAll(async () => {
  await db.delete(userCategories).where(eq(userCategories.userId, userA.id)).catch(() => {});
  await db.delete(userCategories).where(eq(userCategories.userId, userB.id)).catch(() => {});
  // users rows are lazily created by requireAuth's ensureLocalUser during
  // the requests below, not seeded here -- best-effort cleanup only, see
  // events-adapter-live.test.ts for why this is fine on a disposable branch.
}, 30_000);

describe("PUT /categories/color", () => {
  it("sets a color override on a default category that has no row yet", async () => {
    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: "Groceries", color: "#123456" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Groceries");
    expect(res.body.color).toBe("#123456");
  });

  it("GET /categories reflects the override", async () => {
    const res = await request(app).get("/api/categories").set(headersA);
    expect(res.status).toBe(200);
    const row = res.body.find((c: any) => c.name === "Groceries");
    expect(row?.color).toBe("#123456");
  });

  it("re-PUT upserts the same row instead of creating a duplicate", async () => {
    const first = await request(app).get("/api/categories").set(headersA);
    const firstId = first.body.find((c: any) => c.name === "Groceries").id;

    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: "Groceries", color: "#654321" });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe("#654321");
    expect(res.body.id).toBe(firstId);

    const after = await request(app).get("/api/categories").set(headersA);
    const groceriesRows = after.body.filter((c: any) => c.name === "Groceries");
    expect(groceriesRows).toHaveLength(1);
  });

  it("color: null clears the override", async () => {
    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: "Groceries", color: null });
    expect(res.status).toBe(200);
    expect(res.body.color).toBeNull();
  });

  it("rejects an unknown category name", async () => {
    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: "Not A Real Category", color: "#111111" });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid color value", async () => {
    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: "Groceries", color: "blue" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing name", async () => {
    const res = await request(app).put("/api/categories/color").set(headersA).send({ color: "#111111" });
    expect(res.status).toBe(400);
  });

  it("works on a genuinely custom category too", async () => {
    const created = await request(app).post("/api/categories").set(headersA).send({ name: customCategoryName });
    expect(created.status).toBe(201);

    const res = await request(app).put("/api/categories/color").set(headersA).send({ name: customCategoryName, color: "#abcdef" });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe("#abcdef");
  });
});

describe("GET /categories cross-user isolation", () => {
  it("a second account sees none of the first account's categories", async () => {
    const res = await request(app).get("/api/categories").set(headersB);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("POST /categories duplicate detection (was dead code before the unique constraint existed)", () => {
  it("rejects a duplicate custom category name with 409", async () => {
    const res = await request(app).post("/api/categories").set(headersA).send({ name: customCategoryName });
    expect(res.status).toBe(409);
  });
});
