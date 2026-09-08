import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // A plain relative string, not path.join(__dirname, ...) -- on
  // Windows, path.join produces backslash-separated paths, which
  // drizzle-kit's internal glob-based schema-file lookup doesn't match
  // (glob libraries generally treat backslash as an escape character,
  // not a path separator, even on Windows). Confirmed: `drizzle-kit
  // push` failed with "No schema files found" despite the resolved
  // absolute path being byte-for-byte correct and the file genuinely
  // existing there -- switching to a relative, forward-slash path fixed
  // it. This is a real, previously-unnoticed cross-platform bug in this
  // config, not something specific to today's schema change.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
