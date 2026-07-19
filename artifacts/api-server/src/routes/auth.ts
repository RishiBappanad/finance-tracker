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

// GET /auth/google — get Google OAuth redirect URL
router.get("/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "https://trackstack-proxy-production.up.railway.app/finance/api/auth/google/callback";

  if (!clientId) {
    return void res.status(500).json({ error: "Google OAuth not configured" });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// GET /auth/google/callback — exchange code for JWT
router.get("/google/callback", async (req, res) => {
  const { code } = req.query as { code: string };
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "https://trackstack-proxy-production.up.railway.app/finance/api/auth/google/callback";

  if (!clientId || !clientSecret) {
    return void res.status(500).json({ error: "Google OAuth not configured" });
  }

  // Exchange code for tokens
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });

  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    console.error("Google token exchange failed:", tokenResp.status, errBody);
    return void res.status(400).json({ error: "Failed to exchange Google code", details: errBody });
  }

  const { access_token } = await tokenResp.json() as { access_token: string };

  // Fetch Google user info
  const userInfoResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  const userInfo = await userInfoResp.json() as { email: string; name?: string };

  if (!userInfo.email) {
    return void res.status(400).json({ error: "Could not get email from Google" });
  }

  // Find or create user
  let [user] = await db.select().from(users).where(eq(users.email, userInfo.email)).limit(1);

  if (!user) {
    const [newUser] = await db.insert(users).values({
      email: userInfo.email,
      passwordHash: "google-oauth",
      name: userInfo.name || null,
    }).returning();
    user = newUser;
  }

  const token = signToken({ userId: user.id, email: user.email });

  // Redirect to app with token in URL fragment
  // Redirect to app with token in URL fragment (client handles it).
  // FRONTEND_BASE_PATH defaults to "/" for standalone deploys (Cloud Run);
  // set to "/finance/" when running behind the proxy.
  const basePath = process.env.FRONTEND_BASE_PATH || "/";
  res.redirect(`${basePath}#google_token=${token}`);
});

export default router;
