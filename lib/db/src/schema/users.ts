import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

// users.id is NOT auto-generated — it's the accountId assigned by
// trackstack-auth, the shared identity service every TrackStack app
// delegates registration/login/Google OAuth to. This table is a local
// mirror (created lazily on first authenticated request, see
// middlewares/auth.ts), not the source of truth for identity/passwords.
export const users = pgTable("users", {
  id: integer("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull().default("trackstack-auth"),
  name: text("name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
