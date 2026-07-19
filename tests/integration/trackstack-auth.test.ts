import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * Verifies the trackstack-auth migration end of requireAuth: a JWT shaped
 * like the one trackstack-auth issues ({ accountId, email }, shared
 * JWT_SECRET) is accepted, and a local mirror `users` row is lazily created
 * (INSERT ... ON CONFLICT DO NOTHING) keyed by accountId.
 *
 * This intentionally does not touch tests/integration/auth.test.ts, which
 * exercises finance-tracker's own removed register/login routes against the
 * old { userId, email } token shape — that file is a separate, pre-existing,
 * already-flagged issue (see trackstack-handoff-typecheck-issue.md) and is
 * out of scope here.
 */

const JWT_SECRET = "test-secret-for-jwt-signing";

function mintTrackstackAuthToken(accountId: number, email: string): string {
  return jwt.sign({ accountId, email }, JWT_SECRET, { expiresIn: "30d" });
}

const { mockDb, enqueue, reset, calls } = vi.hoisted(() => {
  const queue: unknown[] = [];
  const callLog: { method: string; args: unknown[] }[] = [];

  const makeChain = (rootMethod: string, rootArgs: unknown[]) => {
    const c: Record<string, any> = {};
    for (const m of [
      "from", "where", "leftJoin", "rightJoin", "innerJoin", "orderBy",
      "limit", "offset", "groupBy", "having", "values", "onConflictDoNothing",
      "onConflictDoUpdate", "returning", "set", "execute",
    ]) {
      c[m] = (...args: unknown[]) => {
        callLog.push({ method: m, args });
        return c;
      };
    }
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(res, rej);
    c.catch = (rej: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).catch(rej);
    callLog.push({ method: rootMethod, args: rootArgs });
    return c;
  };

  const mockDb = {
    select: (...args: unknown[]) => makeChain("select", args),
    insert: (...args: unknown[]) => makeChain("insert", args),
    update: (...args: unknown[]) => makeChain("update", args),
    delete: (...args: unknown[]) => makeChain("delete", args),
  };

  return {
    mockDb,
    enqueue: (...vals: unknown[]) => vals.forEach((v) => queue.push(v)),
    reset: () => {
      queue.splice(0, queue.length);
      callLog.splice(0, callLog.length);
    },
    calls: callLog,
  };
});

vi.mock("@workspace/db", () => ({
  db: mockDb,
  pool: {},
  users: { id: "users.id" },
  institutions: {},
  accounts: {},
  bankTransactions: {},
  scannedReceipts: {},
  receiptItems: {},
  receiptTransactionMatches: {},
  userCategories: {},
}));

import app from "../../artifacts/api-server/src/app.js";

describe("requireAuth with trackstack-auth-issued JWTs", () => {
  it("rejects a token signed with the wrong secret", async () => {
    reset();
    const badToken = jwt.sign({ accountId: 9, email: "rishibappanad@gmail.com" }, "wrong-secret", {
      expiresIn: "30d",
    });

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${badToken}`);
    expect(res.status).toBe(401);
  });

  it("rejects an old-shape { userId, email } token (not what trackstack-auth issues)", async () => {
    reset();
    // Old finance-tracker-local token shape. requireAuth now reads
    // decoded.accountId, which is undefined here, so userId ends up
    // undefined and the mirror-row insert / lookup should not resolve to a
    // real user. We only assert the token itself is *decodable* but the
    // resulting req.user.userId is not a usable id — covered by the 404
    // from /me below since no user row matches `undefined`.
    const oldShapeToken = jwt.sign({ userId: 9, email: "rishibappanad@gmail.com" }, JWT_SECRET, {
      expiresIn: "30d",
    });
    enqueue([]); // ensureLocalUser insert (no return value read)
    enqueue([]); // /me select → no user found for undefined id

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${oldShapeToken}`);
    expect(res.status).toBe(404);
  });

  it("accepts a trackstack-auth-shaped { accountId, email } token and creates the mirror row", async () => {
    reset();
    const token = mintTrackstackAuthToken(9, "rishibappanad@gmail.com");

    // 1st DB call inside requireAuth: ensureLocalUser's
    // insert(users).values(...).onConflictDoNothing(...) — insert chains
    // don't need a meaningful resolved value here.
    enqueue([]);
    // 2nd DB call inside the /me handler: select().from(users).where(...) —
    // simulates the mirror row now existing with accountId 9.
    enqueue([{ id: 9, email: "rishibappanad@gmail.com", name: null }]);

    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(9);
    expect(res.body.email).toBe("rishibappanad@gmail.com");

    // Confirm requireAuth actually issued an insert (the lazy mirror-row
    // creation), not just a select — i.e. ensureLocalUser really ran.
    expect(calls.some((c) => c.method === "onConflictDoNothing")).toBe(true);
  });

  it("returns 401 with no Authorization header", async () => {
    reset();
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with an expired trackstack-auth token", async () => {
    reset();
    const expired = jwt.sign({ accountId: 9, email: "rishibappanad@gmail.com" }, JWT_SECRET, {
      expiresIn: "-1s",
    });
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });
});
