/**
 * Identity (registration, login, Google OAuth) is owned by trackstack-auth,
 * not this service. requireAuth (see middlewares/auth.ts) verifies the
 * shared-secret JWT and ensures a local mirror row exists.
 *
 * The only route kept here is /me, so the frontend can fetch this app's
 * view of the current user's profile without a network call to
 * trackstack-auth on every page load.
 */
import { Router } from "express";
import { db, users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth.js";

const router = Router();

router.get("/me", requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user) {
    return void res.status(404).json({ error: "User not found" });
  }

  res.json({ id: user.id, email: user.email, name: user.name });
});

export default router;
