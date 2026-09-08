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
  // Previously undeclared even though routes/categories.ts already caught
  // a 23505 unique-violation on create as if this existed -- it didn't;
  // confirmed via a live pg_constraint query against production, where
  // user_categories had only a primary key and the users FK. Needed for
  // real by the color-upsert route (onConflictDoUpdate requires an actual
  // constraint to target), and fixes the previously-dead duplicate-name
  // detection in POST / as a side effect.
  (t) => [unique().on(t.userId, t.name)]
);

export type UserCategory = typeof userCategories.$inferSelect;
export type InsertUserCategory = typeof userCategories.$inferInsert;
