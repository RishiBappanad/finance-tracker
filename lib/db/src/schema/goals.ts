import { pgTable, serial, integer, text, real, boolean, date, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";

/**
 * A goal is a saved query plus a threshold ("stay under $400/month on
 * dining"), not an occurrence -- see workspace-notes/
 * RECURRING_AND_GOALS_SPEC.md's "Goals" section for why this isn't a
 * domain_events row.
 *
 * `severity` gives each (userId, category, period) at most two rows: a
 * 'warning' tier and a 'target' (hard cap) tier, per the tiering decision
 * in that spec. `lastStatus`/`lastEvaluatedPeriodStart` together record
 * this goal's most recent evaluation -- whether it was 'compliant' or
 * 'noncompliant', and for which period -- so the event-triggered
 * evaluation path (lib/goals.ts's evaluateGoal) can tell a genuine
 * transition (worth celebrating or warning about) from a goal that's
 * simply still in the same state it was last checked, or from a fresh
 * period's first-ever evaluation (which is a baseline, not a transition).
 */
export const goals = pgTable(
  "goals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    category: text("category"), // nullable -- null means "every category"
    comparator: text("comparator").notNull(), // 'lte' | 'gte' | 'eq'
    targetAmount: real("target_amount").notNull(),
    period: text("period").notNull(), // 'daily' | 'weekly' | 'monthly'
    severity: text("severity").notNull().default("target"), // 'warning' | 'target'
    lastStatus: text("last_status"), // null (never evaluated) | 'compliant' | 'noncompliant'
    lastEvaluatedPeriodStart: date("last_evaluated_period_start"), // the period `lastStatus` was computed for
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Plain UNIQUE only catches two rows that share the same non-null
    // category -- Postgres treats every NULL as distinct from every other
    // NULL, so this alone would let unlimited duplicate "every category"
    // (category IS NULL) goals through for the same period+severity. The
    // second, partial index below closes that gap explicitly, the same
    // way a plain UNIQUE constraint on a nullable column always needs a
    // partial index alongside it to mean "at most one, including the
    // null case."
    uniqueIndex("goals_category_period_severity_unique").on(t.userId, t.category, t.period, t.severity),
    uniqueIndex("goals_all_categories_period_severity_unique")
      .on(t.userId, t.period, t.severity)
      .where(sql`${t.category} IS NULL`),
    // Every domain-event write now looks up this table by (userId,
    // category) to find goals it might affect (see lib/goals.ts's
    // evaluateGoalsForEvent) -- the common case is "no active goal
    // matches this category," so this needs to be a fast, indexed
    // short-circuit rather than a sequential scan on every single event.
    index("goals_user_category_active_idx").on(t.userId, t.category, t.isActive),
  ]
);

export type Goal = typeof goals.$inferSelect;
export type InsertGoal = typeof goals.$inferInsert;
