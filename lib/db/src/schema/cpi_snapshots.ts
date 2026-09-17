import { pgTable, serial, date, real, timestamp } from "drizzle-orm/pg-core";

/**
 * A monthly CPI-U index value, cached locally from the BLS public API
 * (series CUUR0000SA0) -- see workspace-notes/RECURRING_AND_GOALS_SPEC.md's
 * "Advanced Goals" section. This is deliberately a cache, populated by
 * POST /actions/sync-cpi/run on a schedule someone else sets up, never
 * fetched inline: goal evaluation runs synchronously on every domain-event
 * write (see goals-evaluation.ts), and CPI only updates monthly, so an
 * inline HTTP call here would be both slow and a new failure mode on
 * finance-tracker's hot path for no benefit.
 *
 * Not user-scoped -- CPI is the same published number for every user.
 */
export const cpiSnapshots = pgTable("cpi_snapshots", {
  id: serial("id").primaryKey(),
  period: date("period").notNull().unique(), // first-of-month, e.g. 2026-08-01 represents "August 2026"
  indexValue: real("index_value").notNull(), // the raw CPI-U index value (e.g. 314.2), not a % change
  fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
});

export type CpiSnapshot = typeof cpiSnapshots.$inferSelect;
export type InsertCpiSnapshot = typeof cpiSnapshots.$inferInsert;
