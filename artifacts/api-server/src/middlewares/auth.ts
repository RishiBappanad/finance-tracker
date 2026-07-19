import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, users } from "@workspace/db";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

// Tokens are issued by trackstack-auth, not this service. Its claim shape is
// { accountId, email }. We keep the field name `userId` here (rather than
// renaming to accountId everywhere `req.user!.userId` is read across the
// route handlers) so this migration doesn't have to touch every call site —
// it's the same identifier, just sourced externally now instead of from a
// locally-issued token.
export interface AuthPayload {
  userId: number;
  email: string;
}

interface TrackstackAuthClaims {
  accountId: number;
  email: string;
}

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

export function verifyToken(token: string): AuthPayload {
  const decoded = jwt.verify(token, JWT_SECRET) as TrackstackAuthClaims;
  return { userId: decoded.accountId, email: decoded.email };
}

/**
 * Ensure a local mirror row exists for this account. finance-tracker's own
 * tables (institutions, scanned_receipts, user_categories) still have a
 * local foreign key into `users`, so a row needs to exist here — but this
 * table is a cache, not the identity source of truth. Safe to call on every
 * request.
 */
async function ensureLocalUser(payload: AuthPayload): Promise<void> {
  await db
    .insert(users)
    .values({ id: payload.userId, email: payload.email, name: null })
    .onConflictDoNothing({ target: users.id });
}

/**
 * Auth middleware — extracts and validates a trackstack-auth JWT from the
 * Authorization header. Attaches user to req.user. Returns 401 if
 * missing/invalid.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  try {
    req.user = verifyToken(token);
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  ensureLocalUser(req.user)
    .then(() => next())
    .catch(next);
}
