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
  date: date("date").notNull(),
  pending: boolean("pending").notNull().default(false),
  plaidSyncedAt: timestamp("plaid_synced_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BankTransaction = typeof bankTransactions.$inferSelect;
export type InsertBankTransaction = typeof bankTransactions.$inferInsert;
