import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { db, goals, domainEvents } from "@workspace/db";
import { eq, and } from "drizzle-orm";

// Live-database test for the Goals primitive (routes/goals.ts,
// lib/goals.ts, lib/domain-events.ts) -- covers three things a mock db
// can't: the real goals_category_period_severity_unique / goals_all_
// categories_period_severity_unique partial-index pair (POST /goals'
// 409 depends on Postgres actually enforcing them), real spending
// aggregation via aggregateByCategory against real bank_transactions
// rows, and the event-triggered goal_met/goal_exceeded transition
// logging that now runs inside every logDomainEvent() call.
//
// Run via: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const USER_ID = 930_000_000 + (RUN % 90_000_000);
const OTHER_USER_ID = USER_ID + 1;

function authHeader(accountId: number) {
  const token = jwt.sign({ accountId, email: `goals-live-${accountId}@test.trackstack.invalid` }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const headers = authHeader(USER_ID);
const otherHeaders = authHeader(OTHER_USER_ID);
const today = new Date().toISOString().slice(0, 10);

const createdGoalIds: number[] = [];

afterAll(async () => {
  await db.delete(goals).where(eq(goals.userId, USER_ID)).catch(() => {});
  await db.delete(goals).where(eq(goals.userId, OTHER_USER_ID)).catch(() => {});
  await db.delete(domainEvents).where(eq(domainEvents.userId, USER_ID)).catch(() => {});
  // bank_transactions/accounts/institutions rows created via POST
  // /events/log are left in place -- this runs against a disposable
  // Neon branch that gets torn down as a whole, same as the other
  // *-live.test.ts files' convention.
}, 30_000);

async function createGoal(h: Record<string, string>, body: Record<string, unknown>) {
  const res = await request(app).post("/api/goals").set(h).send(body);
  if (res.status === 201) createdGoalIds.push(res.body.id);
  return res;
}

async function logTransaction(category: string, amount: number) {
  return request(app).post("/api/events/log").set(headers).send({
    event_type: "transaction",
    occurred_at: today,
    amount,
    category,
  });
}

/** Seeds a goal's lastStatus for *today's* period, so the next
 * event-triggered evaluation is a genuine transition check rather than a
 * first-ever "establish the baseline" evaluation -- per evaluateGoal's
 * own rule, a goal with no prior evaluation (lastEvaluatedPeriodStart:
 * null) always treats its first check as a fresh baseline and never
 * logs a transition, even if that first check is already noncompliant. */
async function seedBaseline(goalId: number, status: "compliant" | "noncompliant") {
  await db.update(goals).set({ lastStatus: status, lastEvaluatedPeriodStart: today }).where(eq(goals.id, goalId));
}

function eventCount(ownerId: number, eventType: string) {
  return db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.ownerType, "goal"), eq(domainEvents.ownerId, String(ownerId)), eq(domainEvents.eventType, eventType)));
}

describe("POST /goals", () => {
  const category = `Goals Live Test Dining ${RUN}`;

  it("creates a warning + target pair for the same category/period", async () => {
    const warning = await createGoal(headers, { category, comparator: "lte", target_amount: 350, period: "monthly", severity: "warning" });
    expect(warning.status).toBe(201);
    expect(warning.body.severity).toBe("warning");

    const target = await createGoal(headers, { category, comparator: "lte", target_amount: 400, period: "monthly", severity: "target" });
    expect(target.status).toBe(201);
    expect(target.body.severity).toBe("target");
  });

  it("rejects a duplicate severity for the same category/period with 409", async () => {
    const res = await createGoal(headers, { category, comparator: "lte", target_amount: 500, period: "monthly", severity: "target" });
    expect(res.status).toBe(409);
  });

  it("defaults severity to 'target' when omitted", async () => {
    const res = await createGoal(headers, { category: `${category} defaulted`, comparator: "lte", target_amount: 200, period: "weekly" });
    expect(res.status).toBe(201);
    expect(res.body.severity).toBe("target");
  });

  it("rejects an invalid comparator", async () => {
    const res = await createGoal(headers, { category: `${category} invalid`, comparator: "nope", target_amount: 100, period: "daily" });
    expect(res.status).toBe(400);
  });
});

describe("GET /goals/:id/status -- live read against real spending", () => {
  it("lte goal: on_track true below target, false above it", async () => {
    const category = `Goals Live Test LteRead ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });
    expect(created.status).toBe(201);
    const goalId = created.body.id;

    const before = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(before.body.current_amount).toBe(0);
    expect(before.body.on_track).toBe(true);

    await logTransaction(category, 150);

    const after = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(after.body.current_amount).toBe(150);
    expect(after.body.on_track).toBe(false);
    expect(after.body.percent).toBe(150);
  });

  it("gte goal: on_track false below target, true at/above it", async () => {
    const category = `Goals Live Test GteRead ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "gte", target_amount: 50, period: "daily" });
    const goalId = created.body.id;

    const before = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(before.body.on_track).toBe(false);

    await logTransaction(category, 60);

    const after = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(after.body.on_track).toBe(true);
  });

  it("a live status read never writes a domain event, even when crossed", async () => {
    const category = `Goals Live Test ReadNoWrite ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 10, period: "daily" });
    const goalId = created.body.id;

    await seedBaseline(goalId, "compliant");
    await logTransaction(category, 999);
    // Reading status repeatedly must not itself log goal_exceeded --
    // only the event-triggered path (already run once by logTransaction
    // above) does that.
    await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    await request(app).get(`/api/goals/${goalId}/status`).set(headers);

    const exceeded = await eventCount(goalId, "goal_exceeded");
    expect(exceeded).toHaveLength(1);
  });
});

describe("GET /goals -- scoping", () => {
  it("never returns another user's goals", async () => {
    const category = `Goals Live Test Scoping ${RUN}`;
    await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });

    const res = await request(app).get("/api/goals").set(otherHeaders);
    expect(res.status).toBe(200);
    expect(res.body.some((g: any) => g.category === category)).toBe(false);
  });
});

describe("event-triggered evaluation (lib/domain-events.ts -> evaluateGoalsForEvent)", () => {
  it("logs goal_met exactly once on a noncompliant -> compliant transition", async () => {
    const category = `Goals Live Test Met ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "gte", target_amount: 50, period: "daily" });
    const goalId = created.body.id;
    await seedBaseline(goalId, "noncompliant");

    // Starts noncompliant (0 < 50) -- crosses into compliant.
    const first = await logTransaction(category, 60);
    expect(first.status).toBe(200);

    expect(await eventCount(goalId, "goal_met")).toHaveLength(1);

    // Still compliant (110 >= 50) -- must not re-log.
    const second = await logTransaction(category, 50);
    expect(second.status).toBe(200);
    expect(await eventCount(goalId, "goal_met")).toHaveLength(1);
  });

  it("logs goal_exceeded exactly once on a compliant -> noncompliant transition", async () => {
    const category = `Goals Live Test Exceeded ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });
    const goalId = created.body.id;
    await seedBaseline(goalId, "compliant");

    // Starts compliant (0 <= 100) -- crosses into noncompliant.
    await logTransaction(category, 150);
    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);

    // Still noncompliant (250 > 100) -- must not re-log.
    await logTransaction(category, 100);
    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);
  });

  it("a period rollover resets the baseline without logging a transition", async () => {
    const category = `Goals Live Test Rollover ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });
    const goalId = created.body.id;

    // Seed a stale prior evaluation directly -- simulates yesterday's
    // period having ended noncompliant, without waiting a real day.
    await db.update(goals).set({ lastStatus: "noncompliant", lastEvaluatedPeriodStart: "2000-01-01" }).where(eq(goals.id, goalId));

    // Today's first evaluation is also noncompliant (150 > 100) -- same
    // as the stale lastStatus -- but it's a new period, so this must be
    // treated as a fresh baseline, not a "still noncompliant" no-op or a
    // transition.
    await logTransaction(category, 150);

    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(0);

    const [row] = await db.select().from(goals).where(eq(goals.id, goalId));
    expect(row.lastEvaluatedPeriodStart).toBe(today);
    expect(row.lastStatus).toBe("noncompliant");
  });

  it("does not affect a goal scoped to a different category", async () => {
    const category = `Goals Live Test Isolated ${RUN}`;
    const otherCategory = `Goals Live Test Unrelated ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 10, period: "daily" });
    const goalId = created.body.id;

    await logTransaction(otherCategory, 999);

    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(0);
  });
});
