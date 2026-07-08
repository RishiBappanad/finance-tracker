import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { users } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middlewares/auth.js";

const router = Router();

// POST /auth/register
router.post("/register", async (req, res) => {
  const { email, password, name } = req.body;

  if (!email || !password) {
    return void res.status(400).json({ error: "Email and password are required" });
  }

  if (password.length < 6) {
    return void res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  // Check if email already exists
  const existing = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (existing.length > 0) {
    return void res.status(409).json({ error: "Email already registered" });
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [user] = await db
    .insert(users)
    .values({
      email: email.toLowerCase(),
      passwordHash,
      name: name || null,
    })
    .returning();

  const token = signToken({ userId: user.id, email: user.email });

  res.status(201).json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return void res.status(400).json({ error: "Email and password are required" });
  }

  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (!user) {
    return void res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return void res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken({ userId: user.id, email: user.email });

  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

// GET /auth/me — get current user info
router.get("/me", requireAuth, async (req, res) => {
  const [user] = await db.select().from(users).where(eq(users.id, req.user!.userId)).limit(1);
  if (!user) {
    return void res.status(404).json({ error: "User not found" });
  }

  res.json({ id: user.id, email: user.email, name: user.name });
});

export default router;
