import { Router } from "express";
import {
  db,
  goals,
  type Goal,
  computeGoalStatus,
  isValidComparator,
  isValidSeverity,
  type Comparator,
  type Severity,
  isValidGoalQueryPeriod,
  parseGoalQuery,
  type GoalQuery,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

// ── Basic-goal shorthand expansion (decided 2026-09-17) ──────────────────
// `POST`/`PATCH /goals` accepts either the full measure_query/
// reference_query form or a flat shorthand -- see
// RECURRING_AND_GOALS_SPEC.md's "Basic goals stay simple" section. The
// server expands shorthand into the exact same stored shape before
// writing; there is only one stored shape and one evaluation path.
interface ShorthandInput {
  category: string;
  comparator: "lte" | "gte" | "eq";
  target_amount: number;
  period: "daily" | "weekly" | "monthly";
}

function isShorthandInput(body: Record<string, unknown>): body is Record<string, unknown> & ShorthandInput {
  return typeof body.category === "string" && typeof body.target_amount === "number" && typeof body.period === "string" && body.measure_query === undefined;
}

function expandShorthand(input: ShorthandInput): { measureQuery: GoalQuery; referenceAmount: number } {
  return {
    measureQuery: {
      aggregation: "sum",
      filters: [{ field: "category", operator: "eq", value: input.category }],
      timeWindow: { kind: "current_period", period: input.period },
    },
    referenceAmount: input.target_amount,
  };
}

// ── Request-body validation for the full (non-shorthand) form ───────────
// Every aggregation/field/operator value is re-validated here via
// parseGoalQuery (goal-query.ts) even though it will be validated again
// on every read -- rejecting an invalid query at write time gives a
// caller an immediate 400 instead of a query that silently fails to
// evaluate later.
function validateFullForm(body: Record<string, unknown>): string | null {
  const measureQuery = parseGoalQuery(body.measure_query);
  if (typeof measureQuery === "string") return `measure_query: ${measureQuery}`;
  if (measureQuery.scale !== undefined) return "scale belongs on reference_query (it's the multiplier on what you compare against)";

  const hasAmount = typeof body.reference_amount === "number";
  const hasQuery = body.reference_query !== undefined && body.reference_query !== null;
  if (hasAmount === hasQuery) return "exactly one of reference_amount, reference_query is required";
  if (hasQuery) {
    const referenceQuery = parseGoalQuery(body.reference_query);
    if (typeof referenceQuery === "string") return `reference_query: ${referenceQuery}`;
  }
  return null;
}

const DUPLICATE_GOAL_ERROR = "A goal with this definition already exists";

function serializeGoal(g: Goal) {
  return {
    id: g.id,
    label: g.label,
    severity: g.severity,
    is_active: g.isActive,
    comparator: g.comparator,
    tolerance_percent: g.tolerancePercent,
    measure_query: g.measureQuery,
    reference_amount: g.referenceAmount,
    reference_query: g.referenceQuery,
    // The multiplier on a computed reference (the ratio); null when the goal
    // has no computed reference.
    reference_scale: g.referenceQuery === null ? null : ((g.referenceQuery as GoalQuery).scale ?? 1),
    inflation_adjusted: g.inflationAdjusted,
    notify_on_crossing: g.notifyOnCrossing,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  };
}

// GET /goals?active=true
router.get("/", async (req, res) => {
  const conditions = [eq(goals.userId, req.user!.userId)];
  if (req.query.active === "true") conditions.push(eq(goals.isActive, true));

  const rows = await db.select().from(goals).where(and(...conditions)).orderBy(goals.createdAt);
  res.json(rows.map(serializeGoal));
});

interface ParsedGoalInput {
  measureQuery: GoalQuery;
  referenceAmount: number | null;
  referenceQuery: GoalQuery | null;
}

/** Shared by POST and PATCH: accepts either shorthand or full-form input
 * and returns the fields to write, or an error string. Full-form-only
 * fields (comparator/tolerance_percent/severity/label/is_active/
 * inflation_adjusted/notify_on_crossing) are read directly off the body
 * either way -- shorthand only ever supplies measure_query/reference_*. */
function parseGoalInput(body: Record<string, unknown>): ParsedGoalInput | string {
  if (isShorthandInput(body)) {
    if (!isValidComparator(body.comparator) || (body.comparator as string) === "within_tolerance_percent") return "comparator must be one of: lte, gte, eq for shorthand input";
    if (!isValidGoalQueryPeriod(body.period)) return "period must be one of: daily, weekly, monthly";
    const expanded = expandShorthand(body);
    return { measureQuery: expanded.measureQuery, referenceAmount: expanded.referenceAmount, referenceQuery: null };
  }

  const err = validateFullForm(body);
  if (err) return err;
  const measureQuery = parseGoalQuery(body.measure_query) as GoalQuery;
  const referenceQuery = body.reference_query != null ? (parseGoalQuery(body.reference_query) as GoalQuery) : null;
  return { measureQuery, referenceAmount: referenceQuery ? null : (body.reference_amount as number), referenceQuery };
}

// POST /goals -- severity defaults to 'target'; accepts shorthand or full form
router.post("/", async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const severity = body.severity ?? "target";
  const comparator = body.comparator;

  if (!isValidComparator(comparator)) return void res.status(400).json({ error: "comparator must be one of: lte, gte, eq, within_tolerance_percent" });
  if (comparator === "within_tolerance_percent" && typeof body.tolerance_percent !== "number") return void res.status(400).json({ error: "tolerance_percent is required when comparator is within_tolerance_percent" });
  if (!isValidSeverity(severity)) return void res.status(400).json({ error: "severity must be one of: warning, target" });

  const parsed = parseGoalInput(body);
  if (typeof parsed === "string") return void res.status(400).json({ error: parsed });

  try {
    const [row] = await db
      .insert(goals)
      .values({
        userId: req.user!.userId,
        label: typeof body.label === "string" ? body.label : null,
        severity,
        comparator,
        tolerancePercent: comparator === "within_tolerance_percent" ? (body.tolerance_percent as number) : null,
        measureQuery: parsed.measureQuery,
        referenceAmount: parsed.referenceAmount,
        referenceQuery: parsed.referenceQuery,
        inflationAdjusted: Boolean(body.inflation_adjusted),
        notifyOnCrossing: body.notify_on_crossing === undefined ? true : Boolean(body.notify_on_crossing),
      })
      .returning();

    res.status(201).json(serializeGoal(row));
  } catch (e: any) {
    if (e.cause?.code === "23505") return void res.status(409).json({ error: DUPLICATE_GOAL_ERROR });
    throw e;
  }
});

// PATCH /goals/:id -- edit any field, pause (is_active: false), or re-tier (severity)
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;

  if (body.comparator !== undefined && !isValidComparator(body.comparator)) return void res.status(400).json({ error: "comparator must be one of: lte, gte, eq, within_tolerance_percent" });
  if (body.severity !== undefined && !isValidSeverity(body.severity)) return void res.status(400).json({ error: "severity must be one of: warning, target" });
  if (body.comparator === "within_tolerance_percent" && typeof body.tolerance_percent !== "number") return void res.status(400).json({ error: "tolerance_percent is required when comparator is within_tolerance_percent" });

  const updates: Partial<typeof goals.$inferInsert> = { updatedAt: new Date() };
  if (body.label !== undefined) updates.label = body.label === null ? null : String(body.label);
  if (body.severity !== undefined) updates.severity = body.severity as string;
  if (body.is_active !== undefined) updates.isActive = Boolean(body.is_active);
  if (body.comparator !== undefined) updates.comparator = body.comparator as string;
  if (body.tolerance_percent !== undefined) updates.tolerancePercent = body.tolerance_percent as number;
  if (body.inflation_adjusted !== undefined) updates.inflationAdjusted = Boolean(body.inflation_adjusted);
  if (body.notify_on_crossing !== undefined) updates.notifyOnCrossing = Boolean(body.notify_on_crossing);

  // Edit just the ratio's multiplier, leaving the query alone.
  let scaleOnlyEdit = false;
  if (body.reference_scale !== undefined) {
    if (typeof body.reference_scale !== "number" || !Number.isFinite(body.reference_scale) || body.reference_scale <= 0) {
      return void res.status(400).json({ error: "reference_scale must be a positive number" });
    }
    scaleOnlyEdit = true;
  }

  const hasQueryEdit = body.measure_query !== undefined || body.reference_amount !== undefined || body.reference_query !== undefined || body.category !== undefined || body.target_amount !== undefined || body.period !== undefined;
  if (scaleOnlyEdit && !hasQueryEdit) {
    const current = await loadOwnedGoal(req.user!.userId, id);
    if (!current) return void res.status(404).json({ error: "Goal not found" });
    if (current.referenceQuery === null) return void res.status(400).json({ error: "reference_scale only applies to a goal compared against a computed value" });
    const { scale: _drop, ...rest } = current.referenceQuery as GoalQuery;
    updates.referenceQuery = body.reference_scale === 1 ? rest : { ...rest, scale: body.reference_scale as number };
  }
  if (hasQueryEdit) {
    const parsed = parseGoalInput(body);
    if (typeof parsed === "string") return void res.status(400).json({ error: parsed });
    updates.measureQuery = parsed.measureQuery;
    updates.referenceAmount = parsed.referenceAmount;
    updates.referenceQuery = parsed.referenceQuery;
  }

  try {
    const [row] = await db
      .update(goals)
      .set(updates)
      .where(and(eq(goals.id, id), eq(goals.userId, req.user!.userId)))
      .returning();

    if (!row) return void res.status(404).json({ error: "Goal not found" });
    res.json(serializeGoal(row));
  } catch (e: any) {
    if (e.cause?.code === "23505") return void res.status(409).json({ error: DUPLICATE_GOAL_ERROR });
    throw e;
  }
});

// DELETE /goals/:id
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [deleted] = await db
    .delete(goals)
    .where(and(eq(goals.id, id), eq(goals.userId, req.user!.userId)))
    .returning();

  if (!deleted) return void res.status(404).json({ error: "Goal not found" });
  res.status(204).send();
});

async function loadOwnedGoal(userId: number, id: number): Promise<Goal | undefined> {
  const [goal] = await db.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, userId)));
  return goal;
}

interface GoalStatusResponse {
  measure_value: number;
  reference_value: number;
  comparator: Comparator;
  tolerance_percent: number | null;
  percent: number;
  on_track: boolean;
  severity: Severity;
}

/** A pure, non-mutating read -- goals is pure definition now (no
 * lastStatus/lastEvaluatedPeriodStart to touch), so this and the event-
 * triggered path (goals-evaluation.ts's evaluateGoalTransition) both
 * call the exact same computeGoalStatus, and can never disagree on the
 * number. Celebratory/warning logging happens only from the event-
 * triggered path, never from a status read. */
async function readGoalStatus(goal: Goal): Promise<GoalStatusResponse> {
  const evaluated = await computeGoalStatus(db, goal);
  return {
    measure_value: evaluated.measure_value,
    reference_value: evaluated.reference_value,
    comparator: evaluated.comparator,
    tolerance_percent: evaluated.tolerance_percent,
    percent: evaluated.percent,
    on_track: evaluated.is_compliant,
    severity: evaluated.severity,
  };
}

// GET /goals/:id/status
router.get("/:id/status", async (req, res) => {
  const goal = await loadOwnedGoal(req.user!.userId, Number(req.params.id));
  if (!goal) return void res.status(404).json({ error: "Goal not found" });

  res.json(await readGoalStatus(goal));
});

/** The measure_query's own category filter, if it's a single eq filter on
 * "category" -- used only to key the status-by-category grouping below;
 * an advanced goal with no such filter (e.g. amount-only, or an "in"
 * filter) groups under "__other__" rather than being dropped. */
function categoryHintFor(goal: Goal): string {
  const query = goal.measureQuery as GoalQuery | null;
  const categoryFilter = query?.filters?.find((f) => f.field === "category" && f.operator === "eq");
  return typeof categoryFilter?.value === "string" ? categoryFilter.value : "__other__";
}

// GET /goals/status-by-category -- convenience grouping keyed by
// measure_query.filters' category field, where present (see
// categoryHintFor) -- lets a frontend render "warning + hard cap, both
// evaluated" per category in one call, same purpose the old flat-schema
// version served, adapted to the fact that "category" is no longer a
// real column.
router.get("/status-by-category", async (req, res) => {
  const rows = await db.select().from(goals).where(and(eq(goals.userId, req.user!.userId), eq(goals.isActive, true)));

  const byCategory: Record<string, GoalStatusResponse[]> = {};
  for (const goal of rows) {
    const key = categoryHintFor(goal);
    (byCategory[key] ??= []).push(await readGoalStatus(goal));
  }

  res.json(byCategory);
});

// GET /goals/presets -- named starter configs, both basic (shorthand) and
// advanced (full measure_query/reference_query) tiers. Pre-filled request
// bodies only, per RECURRING_AND_GOALS_SPEC.md's "Presets" section -- no
// new server-side concept, so this list can grow without a schema change.
router.get("/presets", (_req, res) => {
  res.json({
    basic: [
      { name: "Monthly cap", comparator: "lte", period: "monthly" },
      { name: "Weekly cap", comparator: "lte", period: "weekly" },
      { name: "Minimum monthly investment/income", comparator: "gte", period: "monthly" },
    ],
    advanced: [
      {
        name: "Rolling 3-month average, ±15%",
        comparator: "within_tolerance_percent",
        tolerance_percent: 15,
        measure_query: { aggregation: "sum", filters: [], timeWindow: { kind: "current_period", period: "monthly" } },
        reference_query: { aggregation: "mean", filters: [], timeWindow: { kind: "trailing", period: "monthly", count: 3 } },
      },
      {
        name: "Year-over-year, inflation-adjusted, ±10%",
        comparator: "within_tolerance_percent",
        tolerance_percent: 10,
        inflation_adjusted: true,
        measure_query: { aggregation: "sum", filters: [], timeWindow: { kind: "current_period", period: "monthly" } },
        reference_query: { aggregation: "mean", filters: [], timeWindow: { kind: "same_period_last_year", period: "monthly", count: 1 } },
      },
      {
        name: "Outlier watch (95th percentile this year)",
        comparator: "lte",
        measure_query: { aggregation: "percentile", percentile: 95, filters: [], timeWindow: { kind: "current_period", period: "monthly" } },
        reference_query: { aggregation: "percentile", percentile: 95, filters: [], timeWindow: { kind: "all_time" } },
      },
      {
        name: "Week-over-week trend, ±10%",
        comparator: "within_tolerance_percent",
        tolerance_percent: 10,
        measure_query: { aggregation: "sum", filters: [], timeWindow: { kind: "current_period", period: "weekly" } },
        reference_query: { aggregation: "mean", filters: [], timeWindow: { kind: "trailing", period: "weekly", count: 1 } },
      },
    ],
  });
});

export default router;
