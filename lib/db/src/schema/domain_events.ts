import { pgTable, serial, integer, text, real, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users";

// Universal Event Contract's actual backing store (2026-09-14) -- the
// Drizzle/finance-tracker sibling of nutrition-insights'
// app/db/__init__.py domain_events table (same shape, same reasoning,
// deliberately not shared code across trackers per CLAUDE.md Tenet #1).
// Generalizes todo-tracker's own todo_events append-only pattern across
// every domain entity this tracker owns, replacing the previous
// approach of GET /events deriving events live from bankTransactions'
// current rows -- which could only ever answer "this exists right now,"
// never "this was updated" or "this was deleted after the fact."
//
// ownerId is TEXT rather than INTEGER (unlike nutrition-insights') --
// this tracker's owning tables use a mix of PK types (bankTransactions/
// accounts use Plaid's own string ids, scannedReceipts/receiptItems/
// receiptTransactionMatches/userCategories use a serial integer), so a
// single owner_id column has to accommodate both; callers of
// logDomainEvent() pass `String(id)` for the integer-keyed tables.
//
// occurredAt is the entity's own business date where one exists (e.g.
// a receipt's purchaseDate) and defaults to insert time otherwise;
// loggedAt is always real insert time -- kept as two separate columns
// (not one) for the same reason nutrition-insights' domain_events adds
// its own `logged_at`: an event's business date and the moment it was
// written down are genuinely different things once any owning entity
// can be backdated, and collapsing them into one column silently breaks
// the Core Event Shape's own occurred_at/created_at distinction.
export const domainEvents = pgTable(
  "domain_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    eventType: text("event_type").notNull(),
    category: text("category"),
    amount: real("amount").notNull().default(0),
    label: text("label"),
    source: text("source"),
    sourceId: text("source_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    loggedAt: timestamp("logged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_domain_events_user_id").on(t.userId),
    index("idx_domain_events_owner").on(t.ownerType, t.ownerId),
  ]
);

export type DomainEvent = typeof domainEvents.$inferSelect;
export type InsertDomainEvent = typeof domainEvents.$inferInsert;
