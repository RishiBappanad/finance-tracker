import { defineConfig } from "vitest/config";
import path from "path";

// Separate config for tests/integration/user-scoping-live.test.ts, which
// intentionally does NOT mock @workspace/db -- it runs real HTTP requests
// through the real Express app against a real (disposable Neon branch)
// Postgres database, to prove cross-user data isolation. The mock-based
// db-mock.ts chain used by every other test file can't do this: its
// .where()/.innerJoin() calls ignore their arguments entirely, so it can
// never verify a WHERE clause actually filters by user. This config keeps
// that global mock env (tests/vitest.config.ts's DATABASE_URL) from ever
// shadowing the real one this file needs.
//
// Run with: DATABASE_URL=<live-branch-url> npx vitest run --config tests/vitest.live.config.ts
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: [
      "tests/integration/user-scoping-live.test.ts",
      "tests/integration/events-adapter-live.test.ts",
      "tests/integration/categories-live.test.ts",
    ],
    testTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      JWT_SECRET: "test-secret-for-jwt-signing",
      PLAID_CLIENT_ID: "test-plaid-client-id",
      PLAID_SECRET: "test-plaid-secret",
      PLAID_ENV: "sandbox",
      PORT: "0",
    },
    pool: "forks",
  },
  resolve: {
    alias: {
      "@workspace/db": path.resolve(__dirname, "../lib/db/src/index.ts"),
      "@workspace/api-zod": path.resolve(__dirname, "../lib/api-zod/src/index.ts"),
      // The test file imports drizzle-orm directly (to build WHERE clauses
      // for its own cleanup/verification queries); it's only installed
      // under lib/db's node_modules (pnpm's strict linking), not hoisted to
      // the repo root where this test file lives.
      "drizzle-orm": path.resolve(__dirname, "../lib/db/node_modules/drizzle-orm"),
    },
  },
});
