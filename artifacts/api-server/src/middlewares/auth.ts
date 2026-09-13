import { type Request, type Response, type NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db, users } from "@workspace/db";

// Was `process.env.JWT_SECRET || "dev-secret-change-in-production"` -- a
// silent fallback that let this service run with a guessable, publicly-
// visible secret if the real one ever failed to load, instead of refusing
// to start. This is exactly the failure mode that let a real JWT_SECRET
// mismatch between this service and trackstack-auth (the token issuer) go
// unnoticed for a while: tokens trackstack-auth issued were silently
// rejected here, but the service itself looked healthy throughout. Failing
// loudly at import time matches how trackstack-auth itself already
// handles this.
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required but was not provided.");
}
const JWT_SECRET = process.env.JWT_SECRET;

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

// trackstack-auth is the only place personal-access-token storage/lookup
// lives -- a token this service's own JWT verification doesn't recognize
// is checked against trackstack-auth's POST /tokens/verify instead,
// mirroring todo-tracker's requireAuth (the first tracker to actually
// implement this). Despite ACTIONS_CONTRACT_SPEC.md documenting PATs as
// working "everywhere requireAuth is used," this service never actually
// had the fallback -- confirmed live: a real PAT returned 401 here while
// working fine against todo-tracker.
const TRACKSTACK_AUTH_URL = process.env.TRACKSTACK_AUTH_URL;

async function verifyPersonalAccessToken(token: string): Promise<AuthPayload | null> {
  if (!TRACKSTACK_AUTH_URL) return null;
  try {
    const res = await fetch(`${TRACKSTACK_AUTH_URL}/tokens/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { account: { accountId: number; email: string } };
    return { userId: data.account.accountId, email: data.account.email };
  } catch {
    return null;
  }
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
 * Authorization header, falling back to a personal access token if it
 * isn't a valid JWT. Attaches user to req.user. Returns 401 if
 * missing/invalid.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const token = header.slice(7);
  let user: AuthPayload | null = null;
  try {
    user = verifyToken(token);
  } catch {
    // Not a valid JWT -- fall through and try it as a PAT below.
  }
  if (!user) {
    user = await verifyPersonalAccessToken(token);
  }
  if (!user) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  req.user = user;
  ensureLocalUser(req.user)
    .then(() => next())
    .catch(next);
}
