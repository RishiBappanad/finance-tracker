import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-for-jwt-signing";

export interface TestUser {
  userId: number;
  email: string;
}

export const userA: TestUser = { userId: 1, email: "alice@test.com" };
export const userB: TestUser = { userId: 2, email: "bob@test.com" };

export function makeToken(user: TestUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "1h" });
}

export function authHeader(user: TestUser): { Authorization: string } {
  return { Authorization: `Bearer ${makeToken(user)}` };
}
