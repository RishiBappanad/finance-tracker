import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-for-jwt-signing";

// requireAuth verifies a trackstack-auth-issued JWT ({ accountId, email }),
// not a locally-issued one — see artifacts/api-server/src/middlewares/auth.ts.
export interface TestUser {
  accountId: number;
  email: string;
}

export const userA: TestUser = { accountId: 1, email: "alice@test.com" };
export const userB: TestUser = { accountId: 2, email: "bob@test.com" };

export function makeToken(user: TestUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "1h" });
}

export function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${makeToken(user)}` };
}
