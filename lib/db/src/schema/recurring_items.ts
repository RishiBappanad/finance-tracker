import { pgTable, serial, integer, text, real, boolean, date, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * A recurring item is a FORECAST -- "rent, about $1800, due the 1st through
 * the 5th" -- not a fact, so it lives in its own table rather than as a
 * `domain_events` row (see workspace-notes/RECURRING_AND_GOALS_SPEC.md, "Why
 * neither of these is just a domain_events row"). Real transactions stay
 * ordinary `domain_events` rows with no awareness of this table; a periodic
 * matching step (services/recurring-sync.ts) pairs them up afterwards.
 *
 * `cadence` is one of weekly | biweekly | semi_monthly | monthly | annually |
 * custom ('custom' repeats every `intervalDays` days). `anchorDate` is what the
 * cadence counts from and is never rewritten by when an occurrence is actually
 * done, so a late payment doesn't drift the schedule.
 *
 * The RANGE: each occurrence has a nominal date plus a window
 * [date - windowBeforeDays, date + windowAfterDays] in which doing it counts as
 * on time ("pay rent the 1st to the 5th" = monthly, 0 before, 4 after).
 *
 * `todoConfig` (null = don't sync to a to-do list) shapes the to-do that
 * appears for each occurrence -- see lib/recurrence.ts's TodoConfig.
 *
 * `source`/`sourceId`: 'user' for hand-made items; 'plaid' with the stream id
 * for autodetected ones, which arrive unconfirmed (`confirmed = false`) until a
 * person accepts them. "Dismiss" turns `isActive` off instead of deleting the
 * row, so the next Plaid sync sees the stream is already known and doesn't
 * suggest it again.
 */
export const recurringItems = pgTable(
  "recurring_items",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    label: text("label").notNull(),
    category: text("category"),
    // Signed like bank_transactions.amount: positive = money out, negative = money in.
    expectedAmount: real("expected_amount"),
    cadence: text("cadence").notNull(),
    intervalDays: integer("interval_days"), // required iff cadence = 'custom'
    anchorDate: date("anchor_date").notNull(),
    nextExpectedDate: date("next_expected_date").notNull(),
    windowBeforeDays: integer("window_before_days").notNull().default(0),
    windowAfterDays: integer("window_after_days").notNull().default(0),
    // What a bank transaction's merchant should look like; falls back to the label.
    merchantHint: text("merchant_hint"),
    source: text("source").notNull().default("user"),
    sourceId: text("source_id"),
    confirmed: boolean("confirmed").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    todoConfig: jsonb("todo_config").$type<unknown>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("recurring_items_user_active_idx").on(t.userId, t.isActive),
    // One row per Plaid stream per user (Postgres treats NULL sourceIds as
    // distinct, so hand-made items are unaffected).
    unique("recurring_items_user_source_unique").on(t.userId, t.source, t.sourceId),
  ]
);

export type RecurringItem = typeof recurringItems.$inferSelect;
export type InsertRecurringItem = typeof recurringItems.$inferInsert;
