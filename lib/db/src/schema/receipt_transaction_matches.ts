import { pgTable, serial, integer, text, real, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { scannedReceipts } from "./scanned_receipts";
import { bankTransactions } from "./bank_transactions";

export const receiptTransactionMatches = pgTable(
  "receipt_transaction_matches",
  {
    id: serial("id").primaryKey(),
    receiptId: integer("receipt_id")
      .notNull()
      .references(() => scannedReceipts.id, { onDelete: "cascade" }),
    bankTransactionId: text("bank_transaction_id")
      .notNull()
      .references(() => bankTransactions.id),
    matchMethod: text("match_method").notNull().default("auto"),
    confidenceScore: real("confidence_score"),
    scoreBreakdown: text("score_breakdown"),
    confirmed: boolean("confirmed").notNull().default(false),
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique().on(t.receiptId, t.bankTransactionId)]
);

export type ReceiptTransactionMatch = typeof receiptTransactionMatches.$inferSelect;
export type InsertReceiptTransactionMatch = typeof receiptTransactionMatches.$inferInsert;
