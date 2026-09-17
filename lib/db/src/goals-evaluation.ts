/**
 * Goal evaluation -- per workspace-notes/RECURRING_AND_GOALS_SPEC.md's
 * "Goals" section (2026-09-17 generalized model), a goal compares a
 * `measure` GoalQuery against a `reference` (a constant or itself a
 * GoalQuery) via `comparator`. This module owns comparator logic,
 * inflation adjustment of a computed reference value, and the event-
 * triggered before/after transition check -- the actual query
 * evaluation itself lives in goal-query.ts (the reusable interpreter).
 *
 * No persisted evaluation state: unlike the superseded 43c454b design,
 * this table is pure definition (see schema/goals.ts) -- both sides of a
 * transition check are computed live, every time, by re-running the
 * measure/reference queries with and without the just-inserted event.
 *
 * Lives in lib/db, not the app layer, specifically so domain-events.ts's
 * logDomainEvent() can call evaluateGoalsForEvent() directly after every
 * write, all within the one module boundary tests/helpers/db-mock.ts
 * already mocks as a unit -- an app-layer wrapper around logDomainEvent
 * was tried first (for the superseded design) and reverted: it ran
 * outside that mock boundary, so its extra `goals` table lookup silently
 * consumed queue slots meant for each mocked test's own next query,
 * breaking tests across the app's mock-based suite that had nothing to
 * do with Goals. Living here means db-mock.ts's existing no-op mock of
 * this exact function continues to fully replace this behavior in every
 * such test, with zero changes needed to any of them.
 */
import { eq, and } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { goals, type Goal } from "./schema/goals";
import { logDomainEvent as writeDomainEvent } from "./domain-events";
import { evaluateGoalQuery, couldMatchEvent, parseGoalQuery, type GoalQuery } from "./goal-query";
import { cpiIndexForMonth } from "./cpi-lookup";

type Database = NodePgDatabase<typeof schema>;

export const COMPARATORS = ["lte", "gte", "eq", "within_tolerance_percent"] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const SEVERITIES = ["warning", "target"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isValidComparator(value: unknown): value is Comparator {
  return typeof value === "string" && (COMPARATORS as readonly string[]).includes(value);
}

export function isValidSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

export function isCompliant(comparator: Comparator, measure: number, reference: number, tolerancePercent?: number): boolean {
  if (comparator === "lte") return measure <= reference;
  if (comparator === "gte") return measure >= reference;
  if (comparator === "eq") return measure === reference;
  // within_tolerance_percent -- a symmetric ±tolerancePercent% band
  // around `reference`, per the request's own "(+/-) p percent" framing
  // (a two-sided band, not a directional lte/gte check).
  const delta = reference * (tolerancePercent! / 100);
  return measure >= reference - delta && measure <= reference + delta;
}

export function percentOfReference(measure: number, reference: number): number {
  if (reference === 0) return measure === 0 ? 0 : 100;
  return Math.round((measure / reference) * 10000) / 100;
}

/** Adjusts a computed reference value for inflation into the current
 * period's dollars, using the ratio of cached CPI-U index values. Falls
 * back to the unadjusted value -- logging a warning, never throwing --
 * when either month's snapshot isn't cached, since this can run inside
 * the same transaction as an unrelated domain-event write: a missing
 * macroeconomic data point must never fail someone's transaction/
 * receipt/category write. Only meaningful when both the current period
 * and the reference query's (most recent contributing) range are exactly
 * one calendar month -- returns the raw value unchanged otherwise, since
 * CPI is monthly data and there's no sensible adjustment at other
 * granularities. */
export async function inflationAdjustReference(db: Database, rawReferenceValue: number, referenceMonth: string | undefined, currentMonth: string | undefined): Promise<number> {
  if (!referenceMonth || !currentMonth) return rawReferenceValue;
  const [refCpi, currentCpi] = await Promise.all([cpiIndexForMonth(db, referenceMonth), cpiIndexForMonth(db, currentMonth)]);
  if (refCpi === null || currentCpi === null) {
    console.warn(`[goals-evaluation] CPI snapshot missing for ${refCpi === null ? referenceMonth : currentMonth} -- using unadjusted reference value`);
    return rawReferenceValue;
  }
  return rawReferenceValue * (currentCpi / refCpi);
}

export interface EvaluatedGoal {
  measure_value: number;
  reference_value: number;
  comparator: Comparator;
  tolerance_percent: number | null;
  percent: number;
  is_compliant: boolean;
  severity: Severity;
}

function parseStoredQuery(raw: unknown, label: string): GoalQuery {
  const parsed = parseGoalQuery(raw);
  if (typeof parsed === "string") throw new Error(`Stored ${label} on goal is invalid: ${parsed}`);
  return parsed;
}

/**
 * Evaluates one goal's current measure_value/reference_value/compliance,
 * excluding `excludeEventId` from both queries when given -- the "before"
 * half of the event-triggered transition check (evaluateGoalsForEvent
 * below) passes the just-inserted event's id here to compute what the
 * result would have been without it; a live status read (routes/
 * goals.ts) omits it. Pure -- no writes, matching the "goals table is
 * pure definition" invariant; the only writes Goals ever produces are
 * the goal_met/goal_exceeded domain_events rows, written by
 * evaluateGoalsForEvent, never by this function.
 */
export async function computeGoalStatus(db: Database, goal: Goal, options: { now?: Date; excludeEventId?: number } = {}): Promise<EvaluatedGoal> {
  const measureQuery = parseStoredQuery(goal.measureQuery, "measure_query");
  const measure = await evaluateGoalQuery(db, goal.userId, measureQuery, options);

  let referenceValue: number;
  let referenceMonth: string | undefined;
  if (goal.referenceQuery !== null) {
    const referenceQuery = parseStoredQuery(goal.referenceQuery, "reference_query");
    const reference = await evaluateGoalQuery(db, goal.userId, referenceQuery, options);
    referenceValue = reference.value;
    // The most recent contributing range is the representative period
    // for inflation adjustment when reference_query averages several
    // (trailing/same_period_last_year with count > 1) -- see
    // inflationAdjustReference's doc comment.
    referenceMonth = reference.ranges.reduce<string | undefined>((latest, r) => (r.monthForCpi && (!latest || r.monthForCpi > latest) ? r.monthForCpi : latest), undefined);
  } else {
    referenceValue = goal.referenceAmount!;
  }

  if (goal.inflationAdjusted && goal.referenceQuery !== null) {
    const currentMonth = measure.ranges[0]?.monthForCpi;
    referenceValue = await inflationAdjustReference(db, referenceValue, referenceMonth, currentMonth);
  }

  const comparator = goal.comparator as Comparator;
  return {
    measure_value: measure.value,
    reference_value: Math.round(referenceValue * 100) / 100,
    comparator,
    tolerance_percent: goal.tolerancePercent,
    percent: percentOfReference(measure.value, referenceValue),
    is_compliant: isCompliant(comparator, measure.value, referenceValue, goal.tolerancePercent ?? undefined),
    severity: goal.severity as Severity,
  };
}

/**
 * The event-triggered path: computes compliance twice -- "after" (the
 * normal computeGoalStatus, including the just-inserted event) and
 * "before" (the same computation with that event excluded) -- and logs a
 * transition only when they differ. No goals row is ever written here;
 * "before" vs. "after" are both computed fresh from domain_events'
 * own history each time, so there's no cache to go stale and no period-
 * rollover case to get wrong (Tenet #4).
 */
export async function evaluateGoalTransition(db: Database, goal: Goal, triggeringEventId: number): Promise<void> {
  const [before, after] = await Promise.all([
    computeGoalStatus(db, goal, { excludeEventId: triggeringEventId }),
    computeGoalStatus(db, goal, {}),
  ]);

  if (before.is_compliant === after.is_compliant) return;

  await writeDomainEvent(db, {
    userId: goal.userId,
    ownerType: "goal",
    ownerId: String(goal.id),
    action: after.is_compliant ? "met" : "exceeded",
    category: null,
    label: goal.label ?? `Goal #${goal.id}`,
    metadata: {
      severity: goal.severity,
      comparator: after.comparator,
      measure_value: after.measure_value,
      reference_value: after.reference_value,
    },
  });
}

/**
 * Called from domain-events.ts's logDomainEvent, right after every event
 * is written -- narrows to this user's active goals (goals_user_active_idx),
 * then to those whose measure_query's cheap eq/in filters could plausibly
 * match this event (couldMatchEvent, goal-query.ts) before running the
 * (comparatively expensive, two-query) transition check on each survivor.
 */
export async function evaluateGoalsForEvent(
  db: Database,
  event: { id: number; userId: number; category: string | null; eventType: string; ownerType: string }
): Promise<void> {
  const activeGoals = await db.select().from(goals).where(and(eq(goals.userId, event.userId), eq(goals.isActive, true)));

  for (const goal of activeGoals) {
    const measureQuery = parseStoredQuery(goal.measureQuery, "measure_query");
    if (!couldMatchEvent(measureQuery, event)) continue;
    await evaluateGoalTransition(db, goal, event.id);
  }
}
