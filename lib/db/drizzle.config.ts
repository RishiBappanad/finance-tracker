import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // A plain relative string, not path.join(__dirname, ...) -- on Windows,
  // path.join produces backslash-separated paths, which drizzle-kit's
  // internal glob-based schema-file lookup doesn't match (glob libraries
  // generally treat backslash as an escape character, not a path
  // separator, even on Windows), so `drizzle-kit push` fails with "No
  // schema files found" even when the resolved absolute path is correct
  // and the file exists.
  schema: "./src/schema/index.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
