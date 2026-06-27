import { pgTable, serial, text, real, integer, timestamp, date } from "drizzle-orm/pg-core";

export const scannedReceipts = pgTable("scanned_receipts", {
  id: serial("id").primaryKey(),
  sourceFilePath: text("source_file_path").notNull(),
  sourceFileHash: text("source_file_hash").unique(),
  ocrEngine: text("ocr_engine").notNull().default("tesseract"),
  ocrRawText: text("ocr_raw_text"),
  storeName: text("store_name"),
  storeAddress: text("store_address"),
  purchaseDate: date("purchase_date"),
  subtotal: real("subtotal"),
  tax: real("tax"),
  total: real("total"),
  paymentMethod: text("payment_method"),
  returnWindowDays: integer("return_window_days"),
  returnDeadline: date("return_deadline"),
  processingStatus: text("processing_status").notNull().default("pending"),
  ocrConfidence: real("ocr_confidence"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ScannedReceipt = typeof scannedReceipts.$inferSelect;
export type InsertScannedReceipt = typeof scannedReceipts.$inferInsert;
