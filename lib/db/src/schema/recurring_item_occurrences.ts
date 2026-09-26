import { pgTable, serial, integer, text, real, date, timestamp, index, unique } from "drizzle-orm/pg-core";
import { recurringItems } from "./recurring_items";

/**
 * One predicted occurrence of a recurring item, and what became of it.
 * `windowStart`/`windowEnd` are materialized from the item's before/after days at
 * the moment the occurrence is created, so editing the item later never rewrites
 * an occurrence that already exists (or a to-do already handed out for it).
 *
 * status: pending -> matched (a real transaction satisfied it) | missed (its
 * window closed with nothing found) | skipped (a person said "not this time").
 * These are states of the FORECAST, not events: nothing here goes into
 * `domain_events`.
 *
 * The to-do columns record the one-time hand-off to todo-tracker (see
 * services/recurring-sync.ts): `todoId` is what todo-tracker returned, kept so a
 * later match can close that exact to-do; `todoError` holds the last failure so a
 * retry next run is visible. An occurrence is handed to todo-tracker ONCE and never
 * re-sent, because todo-tracker's upsert overwrites title/notes/due on every call
 * and would undo whatever a person edited on the to-do.
 */
export const recurringItemOccurrences = pgTable(
  "recurring_item_occurrences",
  {
    id: serial("id").primaryKey(),
    recurringItemId: integer("recurring_item_id")
      .notNull()
      .references(() => recurringItems.id, { onDelete: "cascade" }),
    expectedDate: date("expected_date").notNull(),
    windowStart: date("window_start").notNull(),
    windowEnd: date("window_end").notNull(),
    status: text("status").notNull().default("pending"),
    matchedOwnerType: text("matched_owner_type"),
    matchedOwnerId: text("matched_owner_id"),
    matchedAt: timestamp("matched_at"),
    matchScore: real("match_score"),
    todoId: integer("todo_id"),
    todoSyncedAt: timestamp("todo_synced_at"),
    todoClosedAt: timestamp("todo_closed_at"),
    todoError: text("todo_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // The idempotency guarantee: materializing occurrences twice (two
    // overlapping scheduler runs) can never create a second row for a date.
    unique("recurring_occurrences_item_date_unique").on(t.recurringItemId, t.expectedDate),
    index("recurring_occurrences_item_status_idx").on(t.recurringItemId, t.status),
  ]
);

export type RecurringItemOccurrence = typeof recurringItemOccurrences.$inferSelect;
export type InsertRecurringItemOccurrence = typeof recurringItemOccurrences.$inferInsert;
