import { type Request, type Response, type NextFunction } from "express";
import { createRequireAuth, type VerifiedAccount } from "trackstack-ui/auth-client";
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
const TRACKSTACK_AUTH_URL = process.env.TRACKSTACK_AUTH_URL;

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

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
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

// JWT-then-personal-access-token verification is now the shared,
// contract-tested trackstack-ui/auth-client package (this service's own
// hand-copy of it was found to be silently missing the PAT fallback
// entirely, despite ACTIONS_CONTRACT_SPEC.md documenting it as working
// everywhere requireAuth is used -- see that fix's commit for the full
// story). This wrapper only adapts its {accountId, email} shape to this
// service's existing {userId, email} AuthPayload and runs ensureLocalUser
// as part of authenticating, so no route handler needs to change.
const innerRequireAuth = createRequireAuth({
  jwtSecret: JWT_SECRET,
  trackstackAuthUrl: TRACKSTACK_AUTH_URL,
  onAuthenticated: async (account: VerifiedAccount) => {
    await ensureLocalUser({ userId: account.accountId, email: account.email });
  },
});

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // innerRequireAuth calls this callback as either next() (success) or
  // next(err) (an onAuthenticated failure) -- must check for err before
  // treating it as success, or a real downstream error gets silently
  // swallowed and the request proceeds as if authenticated.
  await innerRequireAuth(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    const account = (req as Request & { account?: VerifiedAccount }).account!;
    req.user = { userId: account.accountId, email: account.email };
    next();
  });
}
