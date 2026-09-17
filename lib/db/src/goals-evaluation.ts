/**
 * Goal evaluation -- per workspace-notes/RECURRING_AND_GOALS_SPEC.md's
 * "Goals" section, a goal is purely a saved query plus a threshold. This
 * module has no writes of its own for computing a *current* amount --
 * that comes from aggregateByCategory() (category-aggregation.ts), the
 * same reporting logic GET /transactions/spending-by-category uses, not
 * a re-derivation -- but it does own the transition-detection state
 * (`goals.lastStatus`/`lastEvaluatedPeriodStart`) for the event-
 * triggered path (see evaluateGoal/evaluateGoalsForEvent below).
 *
 * Lives in lib/db, not the app layer, specifically so domain-events.ts's
 * logDomainEvent() can call evaluateGoalsForEvent() directly after every
 * write, all within the one module boundary tests/helpers/db-mock.ts
 * already mocks as a unit -- an app-layer wrapper around logDomainEvent
 * was tried first and reverted: it ran outside that mock boundary, so
 * its extra `goals` table lookup silently consumed queue slots meant
 * for each mocked test's own next query, breaking ~17 previously-passing
 * tests across the app's mock-based suite that had nothing to do with
 * Goals. Living here means db-mock.ts's existing no-op logDomainEvent
 * mock continues to fully replace this behavior in every such test,
 * with zero changes needed to any of them.
 */
import { eq, and, or, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { goals, type Goal } from "./schema/goals";
import { logDomainEvent as writeDomainEvent } from "./domain-events";
import { aggregateByCategory } from "./category-aggregation";

type Database = NodePgDatabase<typeof schema>;

export const COMPARATORS = ["lte", "gte", "eq"] as const;
export type Comparator = (typeof COMPARATORS)[number];

export const PERIODS = ["daily", "weekly", "monthly"] as const;
export type Period = (typeof PERIODS)[number];

export const SEVERITIES = ["warning", "target"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function isValidComparator(value: unknown): value is Comparator {
  return typeof value === "string" && (COMPARATORS as readonly string[]).includes(value);
}

export function isValidPeriod(value: unknown): value is Period {
  return typeof value === "string" && (PERIODS as readonly string[]).includes(value);
}

export function isValidSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}

/** The goal's current evaluation window, as [from, to] date strings
 * (inclusive) -- always "start of period through today," the same
 * partial-period convention dashboard.ts's own /summary route already
 * uses for its monthStart-to-today spend total, rather than a full
 * future-inclusive period. `from` also doubles as this period's
 * identity for transition-detection (see evaluateGoal). */
export function currentPeriodWindow(period: Period, now: Date = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  if (period === "daily") return { from: to, to };
  if (period === "weekly") {
    const weekStart = new Date(now);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    return { from: weekStart.toISOString().slice(0, 10), to };
  }
  return { from: `${to.slice(0, 7)}-01`, to };
}

/** A goal with category: null is scoped to "everything" -- sums every
 * category's spending in the window instead of looking up one. Shared by
 * both the live-read status routes and the event-triggered evaluation
 * path below, so the two can never compute a different number for the
 * same goal. */
export async function computeCurrentAmount(db: Database, goal: Pick<Goal, "userId" | "category" | "period">, now: Date = new Date()): Promise<number> {
  const { from, to } = currentPeriodWindow(goal.period as Period, now);
  const totals = await aggregateByCategory(db, { userId: goal.userId, from, to, direction: "spending" });
  if (goal.category === null) return totals.reduce((sum, t) => sum + t.total, 0);
  return totals.find((t) => t.category === goal.category)?.total ?? 0;
}

export function isCompliant(comparator: Comparator, current: number, target: number): boolean {
  if (comparator === "lte") return current <= target;
  if (comparator === "gte") return current >= target;
  return current === target;
}

export function percentOfTarget(current: number, target: number): number {
  if (target === 0) return current === 0 ? 0 : 100;
  return Math.round((current / target) * 10000) / 100;
}

export interface EvaluatedGoal {
  current_amount: number;
  target_amount: number;
  percent: number;
  is_compliant: boolean;
  severity: Severity;
}

/**
 * Stateful, side-effecting evaluation for the event-triggered path only
 * (see evaluateGoalsForEvent) -- GET /goals/:id/status does NOT call
 * this, since a read endpoint mutating lastStatus could silently eat a
 * real transition if a status check happened to land between two
 * triggering events. Comparator-agnostic: works identically for
 * lte/gte/eq because it compares *compliance* (a bool), never the raw
 * amounts, across evaluations.
 *
 * Three cases, by comparing this evaluation's period + compliance to the
 * goal's stored last evaluation:
 *   1. Different period (`lastEvaluatedPeriodStart` doesn't match) --
 *      including the very first evaluation, when it's still null. This
 *      is a fresh baseline, not a transition: persist and return, no event.
 *   2. Same period, compliance unchanged -- no-op.
 *   3. Same period, compliance changed -- a real transition. Persist AND
 *      log `goal_met` (noncompliant -> compliant) or `goal_exceeded`
 *      (compliant -> noncompliant).
 */
export async function evaluateGoal(db: Database, goal: Goal, currentAmount: number): Promise<EvaluatedGoal> {
  const isCompliantNow = isCompliant(goal.comparator as Comparator, currentAmount, goal.targetAmount);
  const newStatus: "compliant" | "noncompliant" = isCompliantNow ? "compliant" : "noncompliant";
  const { from: periodStart } = currentPeriodWindow(goal.period as Period);
  const periodRolledOver = goal.lastEvaluatedPeriodStart !== periodStart;

  if (periodRolledOver) {
    await db.update(goals).set({ lastStatus: newStatus, lastEvaluatedPeriodStart: periodStart, updatedAt: new Date() }).where(eq(goals.id, goal.id));
  } else if (goal.lastStatus !== newStatus) {
    await db.update(goals).set({ lastStatus: newStatus, updatedAt: new Date() }).where(eq(goals.id, goal.id));
    await writeDomainEvent(db, {
      userId: goal.userId,
      ownerType: "goal",
      ownerId: String(goal.id),
      action: newStatus === "compliant" ? "met" : "exceeded",
      category: goal.category,
      label: `${goal.category ?? "All spending"} ${goal.comparator} ${goal.targetAmount}`,
      metadata: {
        severity: goal.severity,
        comparator: goal.comparator,
        target_amount: goal.targetAmount,
        current_amount: currentAmount,
      },
    });
  }

  return {
    current_amount: currentAmount,
    target_amount: goal.targetAmount,
    percent: percentOfTarget(currentAmount, goal.targetAmount),
    is_compliant: isCompliantNow,
    severity: goal.severity as Severity,
  };
}

/**
 * Called from domain-events.ts's logDomainEvent, right after every event
 * is written -- finds every active goal this event's category could
 * affect (its own category's goals, plus every "everything"/
 * category:null goal) and re-evaluates each. Relies on
 * `goals_user_category_active_idx` (schema/goals.ts) to make the common
 * "no goal matches this category" case a fast indexed lookup rather than
 * a sequential scan on every single event this tracker ever logs.
 */
export async function evaluateGoalsForEvent(db: Database, { userId, category }: { userId: number; category: string | null }): Promise<void> {
  const categoryCondition = category !== null ? or(eq(goals.category, category), isNull(goals.category)) : isNull(goals.category);

  const matches = await db.select().from(goals).where(and(eq(goals.userId, userId), eq(goals.isActive, true), categoryCondition));

  for (const goal of matches) {
    const currentAmount = await computeCurrentAmount(db, goal);
    await evaluateGoal(db, goal, currentAmount);
  }
}
