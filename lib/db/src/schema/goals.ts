import { pgTable, serial, integer, text, real, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * A goal compares a `measure` (a GoalQuery -- see goal-query.ts) against a
 * `reference` (either a plain constant, `referenceAmount`, or itself a
 * GoalQuery over a different time window, `referenceQuery`) via
 * `comparator` -- see workspace-notes/RECURRING_AND_GOALS_SPEC.md's
 * "Goals" section for the full design. This is the cross-tracker-
 * standardized shape (2026-09-17); a flat `category`/`comparator`/
 * `target_amount`/`period` shape shipped once (43c454b) and was
 * superseded before any tracker other than finance-tracker adopted it --
 * see that section's "Migration note".
 *
 * Exactly one of (referenceAmount, referenceQuery) must be non-null --
 * enforced in routes/goals.ts's validation (a Postgres CHECK spanning a
 * scalar and a jsonb column is awkward; this project's convention is to
 * validate shapes like this in code, the same way calendarValidation.ts's
 * parsePushRequestBody does elsewhere).
 *
 * No persisted evaluation state (decided 2026-09-17, reversing an earlier
 * lastStatus/lastEvaluatedPeriodStart cache): domain_events is already a
 * complete, durable history, so "was this goal compliant a moment ago" is
 * just as cheaply computed live (goal-query.ts's evaluateGoalQuery run
 * twice, before/after) as cached -- see goals-evaluation.ts. This table
 * is pure definition: only a user's own create/update/delete/activate
 * ever writes to it; the event-triggered evaluation hot path only reads.
 */
export const goals = pgTable(
  "goals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    label: text("label"), // optional friendly name, e.g. "Dining budget"
    severity: text("severity").notNull().default("target"), // 'warning' | 'target'
    isActive: boolean("is_active").notNull().default(true),
    comparator: text("comparator").notNull(), // 'lte' | 'gte' | 'eq' | 'within_tolerance_percent'
    tolerancePercent: real("tolerance_percent"), // required iff comparator = 'within_tolerance_percent'
    measureQuery: jsonb("measure_query").notNull().$type<unknown>(), // GoalQuery -- the value being watched
    referenceAmount: real("reference_amount"), // set iff referenceQuery is null (the "hardcode it" case)
    referenceQuery: jsonb("reference_query").$type<unknown>(), // GoalQuery -- set iff referenceAmount is null (the "compute it" case)
    inflationAdjusted: boolean("inflation_adjusted").notNull().default(false),
    notifyOnCrossing: boolean("notify_on_crossing").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Narrows "which of this user's goals might this event affect" to a
    // small, cheap set before the (unindexable, JSONB-filter-based) real
    // match check runs in application code -- see
    // goals-evaluation.ts's evaluateGoalsForEvent. Deliberately not a
    // more elaborate denormalized-filter-hint index (e.g. extracting
    // each goal's category/event_type/owner_type eq-filter into its own
    // indexed column): a user's active goal count is small in practice,
    // so "every active goal, filtered in-process" is fast enough without
    // that added complexity (Tenet #2) -- revisit if that stops being true.
    index("goals_user_active_idx").on(t.userId, t.isActive),
  ]
);

export type Goal = typeof goals.$inferSelect;
export type InsertGoal = typeof goals.$inferInsert;
