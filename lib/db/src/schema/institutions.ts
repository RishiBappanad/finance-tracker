import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const institutions = pgTable("institutions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plaidAccessToken: text("plaid_access_token"),
  plaidItemId: text("plaid_item_id"),
  plaidSyncCursor: text("plaid_sync_cursor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Institution = typeof institutions.$inferSelect;
export type InsertInstitution = typeof institutions.$inferInsert;
