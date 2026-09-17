import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { db, goals, domainEvents, cpiSnapshots, upsertCpiSnapshots } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";

// Live-database test for the generalized Goal Query model (routes/goals.ts,
// lib/goal-query.ts, lib/goals-evaluation.ts) -- covers what a mock db
// can't: real aggregation SQL (sum/mean/percentile/count) against real
// bank_transactions-backed domain_events rows, and the event-triggered
// before/after transition check that now runs live on every write instead
// of comparing against a cached lastStatus.
//
// Run via: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts

const { default: app } = await import("../../artifacts/api-server/src/app.js");

const JWT_SECRET = "test-secret-for-jwt-signing";
const RUN = Date.now();
const USER_ID = 940_000_000 + (RUN % 90_000_000);
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

async function logTransaction(category: string, amount: number, occurredAt = today) {
  return request(app).post("/api/events/log").set(headers).send({
    event_type: "transaction",
    occurred_at: occurredAt,
    amount,
    category,
  });
}

function eventCount(ownerId: number, eventType: string) {
  return db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.ownerType, "goal"), eq(domainEvents.ownerId, String(ownerId)), eq(domainEvents.eventType, eventType)));
}

describe("POST /goals -- basic shorthand", () => {
  it("expands shorthand into the full measure_query/reference_amount shape", async () => {
    const category = `Goals Live Shorthand ${RUN}`;
    const res = await createGoal(headers, { category, comparator: "lte", target_amount: 400, period: "monthly" });
    expect(res.status).toBe(201);
    expect(res.body.reference_amount).toBe(400);
    expect(res.body.reference_query).toBeNull();
    expect(res.body.measure_query).toEqual({
      aggregation: "sum",
      filters: [{ field: "category", operator: "eq", value: category }],
      timeWindow: { kind: "current_period", period: "monthly" },
    });
    expect(res.body.severity).toBe("target");
  });

  it("defaults severity to 'target' and accepts a 'warning' tier goal for the same shorthand inputs", async () => {
    const category = `Goals Live Tiers ${RUN}`;
    const warning = await createGoal(headers, { category, comparator: "lte", target_amount: 350, period: "monthly", severity: "warning" });
    expect(warning.status).toBe(201);
    expect(warning.body.severity).toBe("warning");

    const target = await createGoal(headers, { category, comparator: "lte", target_amount: 400, period: "monthly" });
    expect(target.status).toBe(201);
    expect(target.body.severity).toBe("target");
    // No DB-level uniqueness constraint in the generalized model (decided
    // 2026-09-17) -- both rows coexist even though they look related.
  });

  it("rejects an invalid comparator", async () => {
    const res = await createGoal(headers, { category: `x ${RUN}`, comparator: "nope", target_amount: 100, period: "daily" });
    expect(res.status).toBe(400);
  });

  it("rejects within_tolerance_percent via shorthand (advanced-only comparator)", async () => {
    const res = await createGoal(headers, { category: `x2 ${RUN}`, comparator: "within_tolerance_percent", target_amount: 100, period: "daily" });
    expect(res.status).toBe(400);
  });
});

describe("POST /goals -- full form", () => {
  it("accepts a full measure_query/reference_amount goal", async () => {
    const category = `Goals Live Full ${RUN}`;
    const res = await createGoal(headers, {
      comparator: "gte",
      reference_amount: 50,
      measure_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(201);
  });

  it("rejects a body with neither reference_amount nor reference_query", async () => {
    const res = await createGoal(headers, {
      comparator: "lte",
      measure_query: { aggregation: "sum", filters: [], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a body with both reference_amount and reference_query", async () => {
    const res = await createGoal(headers, {
      comparator: "lte",
      reference_amount: 10,
      reference_query: { aggregation: "sum", filters: [], time_window: { kind: "all_time" } },
      measure_query: { aggregation: "sum", filters: [], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid aggregation", async () => {
    const res = await createGoal(headers, {
      comparator: "lte",
      reference_amount: 10,
      measure_query: { aggregation: "nonsense", filters: [], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects percentile aggregation missing the percentile field", async () => {
    const res = await createGoal(headers, {
      comparator: "lte",
      reference_amount: 10,
      measure_query: { aggregation: "percentile", filters: [], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(400);
  });

  it("rejects within_tolerance_percent missing tolerance_percent", async () => {
    const res = await createGoal(headers, {
      comparator: "within_tolerance_percent",
      reference_amount: 10,
      measure_query: { aggregation: "sum", filters: [], time_window: { kind: "current_period", period: "daily" } },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /goals/:id/status -- live read against real spending", () => {
  it("lte goal: on_track true below reference, false above it", async () => {
    const category = `Goals Live LteRead ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });
    expect(created.status).toBe(201);
    const goalId = created.body.id;

    const before = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(before.body.measure_value).toBe(0);
    expect(before.body.on_track).toBe(true);

    await logTransaction(category, 150);

    const after = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(after.body.measure_value).toBe(150);
    expect(after.body.reference_value).toBe(100);
    expect(after.body.on_track).toBe(false);
    expect(after.body.percent).toBe(150);
  });

  it("gte goal: on_track false below reference, true at/above it", async () => {
    const category = `Goals Live GteRead ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "gte", target_amount: 50, period: "daily" });
    const goalId = created.body.id;

    const before = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(before.body.on_track).toBe(false);

    await logTransaction(category, 60);

    const after = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(after.body.on_track).toBe(true);
  });

  it("within_tolerance_percent: compliant inside the band, not outside it", async () => {
    const category = `Goals Live Tolerance ${RUN}`;
    const created = await createGoal(headers, {
      comparator: "within_tolerance_percent",
      tolerance_percent: 10,
      reference_amount: 100,
      measure_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "current_period", period: "daily" } },
    });
    const goalId = created.body.id;

    await logTransaction(category, 105); // within [90, 110]
    const inBand = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(inBand.body.on_track).toBe(true);

    await logTransaction(category, 20); // total 125, outside [90, 110]
    const outOfBand = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(outOfBand.body.on_track).toBe(false);
  });

  it("a live status read never writes a domain event, even when noncompliant", async () => {
    const category = `Goals Live ReadNoWrite ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 10, period: "daily" });
    const goalId = created.body.id;

    await logTransaction(category, 999); // event-triggered path logs goal_exceeded once, here
    await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    await request(app).get(`/api/goals/${goalId}/status`).set(headers);

    const exceeded = await eventCount(goalId, "goal_exceeded");
    expect(exceeded).toHaveLength(1);
  });
});

describe("GET /goals -- scoping", () => {
  it("never returns another user's goals", async () => {
    const category = `Goals Live Scoping ${RUN}`;
    await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });

    const res = await request(app).get("/api/goals").set(otherHeaders);
    expect(res.status).toBe(200);
    expect(res.body.some((g: any) => JSON.stringify(g.measure_query).includes(category))).toBe(false);
  });
});

describe("event-triggered evaluation -- computed live, no persisted state", () => {
  it("logs goal_met exactly once on a noncompliant -> compliant transition, and not again while still compliant", async () => {
    const category = `Goals Live Met ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "gte", target_amount: 50, period: "daily" });
    const goalId = created.body.id;

    // Starts noncompliant (0 < 50) -- crosses into compliant.
    const first = await logTransaction(category, 60);
    expect(first.status).toBe(200);
    expect(await eventCount(goalId, "goal_met")).toHaveLength(1);

    // Still compliant (110 >= 50) -- must not re-log.
    const second = await logTransaction(category, 50);
    expect(second.status).toBe(200);
    expect(await eventCount(goalId, "goal_met")).toHaveLength(1);
  });

  it("logs goal_exceeded exactly once on a compliant -> noncompliant transition, and not again while still noncompliant", async () => {
    const category = `Goals Live Exceeded ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 100, period: "daily" });
    const goalId = created.body.id;

    // Starts compliant (0 <= 100) -- crosses into noncompliant.
    await logTransaction(category, 150);
    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);

    // Still noncompliant (250 > 100) -- must not re-log.
    await logTransaction(category, 100);
    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);
  });

  it("re-crosses correctly with no persisted state to go stale: met, then exceeded, then met again", async () => {
    const category = `Goals Live Recross ${RUN}`;
    // gte 50, daily period, one transaction at a time on fresh days via
    // fixed_range-free daily windows isn't practical in a live test
    // (can't travel through real days) -- exercise the same effect
    // within one day using a category nobody else writes to, driving
    // the running total up and down across the threshold instead.
    const created = await createGoal(headers, { category, comparator: "gte", target_amount: 50, period: "daily" });
    const goalId = created.body.id;

    await logTransaction(category, 60); // 60 >= 50 -- met
    expect(await eventCount(goalId, "goal_met")).toHaveLength(1);

    // amount can go negative to simulate a refund-shaped adjustment,
    // pulling the running sum back under 50 -- exceeded (here "exceeded"
    // means "fell below the gte floor", the generic compliant->
    // noncompliant direction, not literally "spent too much").
    await logTransaction(category, -20); // 40 < 50
    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);

    await logTransaction(category, 20); // 60 >= 50 again
    expect(await eventCount(goalId, "goal_met")).toHaveLength(2);
  });

  it("does not affect a goal scoped to a different category (couldMatchEvent short-circuit)", async () => {
    const category = `Goals Live Isolated ${RUN}`;
    const otherCategory = `Goals Live Unrelated ${RUN}`;
    const created = await createGoal(headers, { category, comparator: "lte", target_amount: 10, period: "daily" });
    const goalId = created.body.id;

    await logTransaction(otherCategory, 999);

    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(0);
  });

  it("a goal with no category filter is affected by events in every category", async () => {
    // Filters on a distinctive amount instead of category -- isolates
    // this test's count from every other test's same-day transactions
    // for this user (a real risk for an unfiltered daily aggregation,
    // since this whole file shares one user/one day), while still
    // proving a goal with no category filter matches events regardless
    // of which category they're in.
    const distinctiveAmount = 7654.01 + (RUN % 1000) / 100;
    const created = await createGoal(headers, {
      comparator: "lte",
      reference_amount: 5,
      measure_query: { aggregation: "count", filters: [{ field: "amount", operator: "eq", value: distinctiveAmount }], time_window: { kind: "current_period", period: "daily" } },
    });
    const goalId = created.body.id;

    for (let i = 0; i < 6; i++) await logTransaction(`Goals Live AmountOnly ${RUN} ${i}`, distinctiveAmount);

    expect(await eventCount(goalId, "goal_exceeded")).toHaveLength(1);
  });
});

describe("advanced: reference_query (rolling trailing average)", () => {
  it("computes a trailing-average reference from real historical months", async () => {
    const category = `Goals Live Trailing ${RUN}`;
    const now = new Date();
    const monthAgo1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
    const monthAgo2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 15)).toISOString().slice(0, 10);

    await logTransaction(category, 100, monthAgo1);
    await logTransaction(category, 200, monthAgo2);
    // trailing average over 2 months = (100 + 200) / 2 = 150

    const created = await createGoal(headers, {
      comparator: "within_tolerance_percent",
      tolerance_percent: 20,
      inflation_adjusted: false,
      measure_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "current_period", period: "monthly" } },
      reference_query: { aggregation: "mean", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "trailing", period: "monthly", count: 2 } },
    });
    expect(created.status).toBe(201);
    const goalId = created.body.id;

    const status = await request(app).get(`/api/goals/${goalId}/status`).set(headers);
    expect(status.body.reference_value).toBe(150);
  });

  it("falls back to the raw reference value when inflation_adjusted is true but no CPI snapshot is cached", async () => {
    const category = `Goals Live NoCpi ${RUN}`;
    const now = new Date();
    const monthAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString().slice(0, 10);
    await logTransaction(category, 80, monthAgo);

    // cpi_snapshots is a global cache, not user-scoped -- a previous test
    // run against this same (disposable, but reused-within-run) database
    // may have already populated these exact real-calendar-month periods
    // (see the "applies inflation adjustment" test below, which shares
    // the same current/prior-month identifiers by construction). Clear
    // them explicitly so this test's "not cached" precondition holds
    // regardless of run history, rather than relying on describe-block
    // ordering within a single run.
    const monthAgoStartForCleanup = monthAgo.slice(0, 8) + "01";
    const currentMonthForCleanup = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    await db.delete(cpiSnapshots).where(inArray(cpiSnapshots.period, [monthAgoStartForCleanup, currentMonthForCleanup]));

    const created = await createGoal(headers, {
      comparator: "lte",
      inflation_adjusted: true,
      measure_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "current_period", period: "monthly" } },
      reference_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "trailing", period: "monthly", count: 1 } },
    });
    expect(created.status).toBe(201);

    // Must not throw/500 despite no cpi_snapshots row existing for either month.
    const status = await request(app).get(`/api/goals/${created.body.id}/status`).set(headers);
    expect(status.status).toBe(200);
    expect(status.body.reference_value).toBe(80); // unadjusted fallback
  });

  it("applies inflation adjustment when CPI snapshots ARE cached", async () => {
    const category = `Goals Live WithCpi ${RUN}`;
    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const monthAgoDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
    const monthAgoStr = monthAgoDate.toISOString().slice(0, 10);
    const monthAgoStart = `${monthAgoDate.getUTCFullYear()}-${String(monthAgoDate.getUTCMonth() + 1).padStart(2, "0")}-01`;

    await logTransaction(category, 100, monthAgoStr);
    // CPI doubled month-over-month (unrealistic, but makes the assertion exact and obvious)
    await upsertCpiSnapshots(db, [
      { period: monthAgoStart, indexValue: 100 },
      { period: currentMonth, indexValue: 200 },
    ]);

    const created = await createGoal(headers, {
      comparator: "gte",
      inflation_adjusted: true,
      measure_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "current_period", period: "monthly" } },
      reference_query: { aggregation: "sum", filters: [{ field: "category", operator: "eq", value: category }], time_window: { kind: "trailing", period: "monthly", count: 1 } },
    });
    const status = await request(app).get(`/api/goals/${created.body.id}/status`).set(headers);
    expect(status.body.reference_value).toBe(200); // 100 * (200/100)
  });
});

describe("GET /goals/presets", () => {
  it("returns both basic and advanced tiers", async () => {
    const res = await request(app).get("/api/goals/presets").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.basic.length).toBeGreaterThan(0);
    expect(res.body.advanced.length).toBeGreaterThan(0);
    expect(res.body.basic[0]).toHaveProperty("comparator");
    expect(res.body.advanced[0]).toHaveProperty("measure_query");
  });
});
