import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { users } from "./users";

export const userCategories = pgTable(
  "user_categories",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    color: text("color"),
    icon: text("icon"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  // Required so onConflictDoUpdate (the color-upsert route) has an actual
  // constraint to target, and so a duplicate-name create reliably fails
  // with a 23505 for routes/categories.ts to catch -- application-level
  // duplicate checks alone can't close the race between two concurrent
  // creates of the same name.
  (t) => [unique().on(t.userId, t.name)]
);

export type UserCategory = typeof userCategories.$inferSelect;
export type InsertUserCategory = typeof userCategories.$inferInsert;
