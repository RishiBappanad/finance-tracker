import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userCategories = pgTable("user_categories", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  color: text("color"),
  icon: text("icon"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type UserCategory = typeof userCategories.$inferSelect;
export type InsertUserCategory = typeof userCategories.$inferInsert;
