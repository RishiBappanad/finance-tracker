import { pgTable, text, real, boolean, date, timestamp } from "drizzle-orm/pg-core";
import { accounts } from "./accounts";

export const bankTransactions = pgTable("bank_transactions", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id),
  amount: real("amount").notNull(),
  currency: text("currency").notNull().default("USD"),
  merchantName: text("merchant_name"),
  merchantNameRaw: text("merchant_name_raw"),
  categoryPrimary: text("category_primary"),
  categoryDetail: text("category_detail"),
  userCategory: text("user_category"),
  ignored: boolean("ignored").notNull().default(false),
  date: date("date").notNull(),
  pending: boolean("pending").notNull().default(false),
  plaidSyncedAt: timestamp("plaid_synced_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Event Contract fields (see workspace-notes/EVENT_CONTRACT_SPEC.md's
  // Resolved Decision #2). `source` defaults to "plaid" at the column
  // level so adding it backfills every existing row automatically (all
  // current rows came from Plaid sync, the only write path before the
  // Event Contract adapter existed) -- no separate backfill script needed
  // for this one. `sourceId` has no matching default (it needs each
  // row's own `id` copied in) -- backfilled once via
  // `UPDATE bank_transactions SET source_id = id WHERE source_id IS NULL`
  // after this migration lands, same one-time-then-done shape as every
  // other additive migration in this project.
  source: text("source").notNull().default("plaid"),
  sourceId: text("source_id"),
});

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type InsertBankTransaction = typeof bankTransactions.$inferInsert;
