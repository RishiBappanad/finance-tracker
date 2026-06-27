import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { institutions } from "./institutions";

export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  institutionId: text("institution_id")
    .notNull()
    .references(() => institutions.id),
  name: text("name").notNull(),
  type: text("type").notNull(),
  subtype: text("subtype"),
  mask: text("mask"),
  currency: text("currency").notNull().default("USD"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;
