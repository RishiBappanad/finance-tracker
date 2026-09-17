import { Router } from "express";
import {
  db,
  goals,
  type Goal,
  computeCurrentAmount,
  isCompliant,
  percentOfTarget,
  isValidComparator,
  isValidPeriod,
  isValidSeverity,
  type Comparator,
  type Severity,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

function serializeGoal(g: Goal) {
  return {
    id: g.id,
    category: g.category,
    comparator: g.comparator,
    target_amount: g.targetAmount,
    period: g.period,
    severity: g.severity,
    is_active: g.isActive,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  };
}

const DUPLICATE_GOAL_ERROR = "A goal with this category, period, and severity already exists";

// GET /goals?active=true
router.get("/", async (req, res) => {
  const conditions = [eq(goals.userId, req.user!.userId)];
  if (req.query.active === "true") conditions.push(eq(goals.isActive, true));

  const rows = await db.select().from(goals).where(and(...conditions)).orderBy(goals.category, goals.period, goals.severity);
  res.json(rows.map(serializeGoal));
});

// POST /goals -- severity defaults to 'target' if omitted
router.post("/", async (req, res) => {
  const { category, comparator, target_amount, period, severity } = req.body;
  const resolvedSeverity = severity ?? "target";

  if (!isValidComparator(comparator)) return void res.status(400).json({ error: "comparator must be one of: lte, gte, eq" });
  if (typeof target_amount !== "number") return void res.status(400).json({ error: "target_amount is required and must be a number" });
  if (!isValidPeriod(period)) return void res.status(400).json({ error: "period must be one of: daily, weekly, monthly" });
  if (!isValidSeverity(resolvedSeverity)) return void res.status(400).json({ error: "severity must be one of: warning, target" });

  try {
    const [row] = await db
      .insert(goals)
      .values({
        userId: req.user!.userId,
        category: category ?? null,
        comparator,
        targetAmount: target_amount,
        period,
        severity: resolvedSeverity,
      })
      .returning();

    res.status(201).json(serializeGoal(row));
  } catch (e: any) {
    // Same e.cause.code pattern routes/categories.ts's 23505 handling
    // uses -- Drizzle wraps the real pg driver error under e.cause, not e.
    if (e.cause?.code === "23505") return void res.status(409).json({ error: DUPLICATE_GOAL_ERROR });
    throw e;
  }
});

// PATCH /goals/:id -- edit any field, pause (is_active: false), or re-tier (severity)
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { category, comparator, target_amount, period, severity, is_active } = req.body;

  if (comparator !== undefined && !isValidComparator(comparator)) return void res.status(400).json({ error: "comparator must be one of: lte, gte, eq" });
  if (period !== undefined && !isValidPeriod(period)) return void res.status(400).json({ error: "period must be one of: daily, weekly, monthly" });
  if (severity !== undefined && !isValidSeverity(severity)) return void res.status(400).json({ error: "severity must be one of: warning, target" });
  if (target_amount !== undefined && typeof target_amount !== "number") return void res.status(400).json({ error: "target_amount must be a number" });

  const updates: Partial<typeof goals.$inferInsert> = { updatedAt: new Date() };
  if (category !== undefined) updates.category = category;
  if (comparator !== undefined) updates.comparator = comparator;
  if (target_amount !== undefined) updates.targetAmount = target_amount;
  if (period !== undefined) updates.period = period;
  if (severity !== undefined) updates.severity = severity;
  if (is_active !== undefined) updates.isActive = Boolean(is_active);

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
  current_amount: number;
  target_amount: number;
  percent: number;
  on_track: boolean;
  severity: Severity;
}

/** A pure, non-mutating read -- unlike @workspace/db's evaluateGoal (the
 * event-triggered path), this never touches lastStatus/
 * lastEvaluatedPeriodStart and never logs a domain event. Celebratory/
 * warning logging happens at write-time now (inside logDomainEvent()),
 * not whenever someone happens to check a goal's status; the two paths
 * share computeCurrentAmount/isCompliant so they can never disagree on
 * the number itself. */
async function readGoalStatus(goal: Goal): Promise<GoalStatusResponse> {
  const currentAmount = await computeCurrentAmount(db, goal);
  return {
    current_amount: currentAmount,
    target_amount: goal.targetAmount,
    percent: percentOfTarget(currentAmount, goal.targetAmount),
    on_track: isCompliant(goal.comparator as Comparator, currentAmount, goal.targetAmount),
    severity: goal.severity as Severity,
  };
}

// GET /goals/:id/status
router.get("/:id/status", async (req, res) => {
  const goal = await loadOwnedGoal(req.user!.userId, Number(req.params.id));
  if (!goal) return void res.status(404).json({ error: "Goal not found" });

  res.json(await readGoalStatus(goal));
});

// GET /goals/status-by-category -- every active goal, evaluated, grouped by
// category (a null-category "everything" goal groups under "__all__") so a
// frontend can render "warning + hard cap, both evaluated" per category in
// one call instead of one request per tier per category.
router.get("/status-by-category", async (req, res) => {
  const rows = await db.select().from(goals).where(and(eq(goals.userId, req.user!.userId), eq(goals.isActive, true)));

  const byCategory: Record<string, GoalStatusResponse[]> = {};
  for (const goal of rows) {
    const key = goal.category ?? "__all__";
    (byCategory[key] ??= []).push(await readGoalStatus(goal));
  }

  res.json(byCategory);
});

export default router;
