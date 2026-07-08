import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      DATABASE_URL: "postgresql://mock:mock@localhost:5432/mock",
      JWT_SECRET: "test-secret-for-jwt-signing",
      PORT: "0",
    },
    pool: "forks",
  },
  resolve: {
    alias: {
      "@workspace/db": path.resolve(__dirname, "../lib/db/src/index.ts"),
      "@workspace/api-zod": path.resolve(__dirname, "../lib/api-zod/src/index.ts"),
    },
  },
});
