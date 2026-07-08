import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const institutions = pgTable("institutions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  plaidAccessToken: text("plaid_access_token"),
  plaidItemId: text("plaid_item_id"),
  plaidSyncCursor: text("plaid_sync_cursor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Institution = typeof institutions.$inferSelect;
export type InsertInstitution = typeof institutions.$inferInsert;
