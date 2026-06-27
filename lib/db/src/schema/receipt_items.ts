import { pgTable, serial, integer, text, real, boolean } from "drizzle-orm/pg-core";
import { scannedReceipts } from "./scanned_receipts";

export const receiptItems = pgTable("receipt_items", {
  id: serial("id").primaryKey(),
  receiptId: integer("receipt_id")
    .notNull()
    .references(() => scannedReceipts.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  quantity: real("quantity").notNull().default(1),
  unitPrice: real("unit_price").notNull(),
  lineTotal: real("line_total").notNull(),
  category: text("category"),
  sku: text("sku"),
  isTaxable: boolean("is_taxable").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export type ReceiptItem = typeof receiptItems.$inferSelect;
export type InsertReceiptItem = typeof receiptItems.$inferInsert;
