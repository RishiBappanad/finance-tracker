import { Router } from "express";
import { db } from "@workspace/db";
import { userCategories, logDomainEvent } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { isValidCategoryName } from "../lib/categories.js";

const router = Router();

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// GET /categories — list user's categories
router.get("/", async (req, res) => {
  const rows = await db
    .select()
    .from(userCategories)
    .where(eq(userCategories.userId, req.user!.userId))
    .orderBy(userCategories.name);

  res.json(rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    createdAt: r.createdAt.toISOString(),
  })));
});

// POST /categories — create a new user category
router.post("/", async (req, res) => {
  const { name, color, icon } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return void res.status(400).json({ error: "Category name is required" });
  }

  const trimmedName = name.trim();

  try {
    const [row] = await db
      .insert(userCategories)
      .values({ userId: req.user!.userId, name: trimmedName, color: color || null, icon: icon || null })
      .returning();

    await logDomainEvent(db, {
      userId: req.user!.userId, ownerType: "user_category", ownerId: String(row.id), action: "created",
      label: row.name, metadata: { color: row.color, icon: row.icon },
    });

    res.status(201).json({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (e: any) {
    // Drizzle wraps the underlying pg driver error -- the real Postgres
    // error code lives at e.cause.code, not e.code (confirmed by hitting
    // this for real: e.code was undefined, e.cause.code was "23505").
    // This check was previously looking at the wrong property and could
    // never have fired, but went unnoticed because user_categories had no
    // unique constraint at all until this same change added one.
    if (e.cause?.code === "23505") {
      return void res.status(409).json({ error: "Category already exists" });
    }
    throw e;
  }
});

// PUT /categories/color — set (or clear) the display color for a category
// name, default or user-created alike. Upserts a user_categories row keyed
// on (userId, name) rather than requiring the category to already exist as
// a user-created row first -- this is how a default category (e.g.
// "Groceries", which has no row of its own until someone customizes it)
// gets a per-user color override. Pass color: null to remove the override
// and fall back to the app's built-in default color for that category.
router.put("/color", async (req, res) => {
  const { name, color } = req.body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return void res.status(400).json({ error: "Category name is required" });
  }
  if (color !== null && (typeof color !== "string" || !HEX_COLOR_RE.test(color))) {
    return void res.status(400).json({ error: "color must be a #rrggbb hex string, or null to clear the override" });
  }

  const trimmedName = name.trim();
  if (!(await isValidCategoryName(trimmedName))) {
    return void res.status(400).json({ error: `Unknown category: ${trimmedName}` });
  }

  const [row] = await db
    .insert(userCategories)
    .values({ userId: req.user!.userId, name: trimmedName, color })
    .onConflictDoUpdate({
      target: [userCategories.userId, userCategories.name],
      set: { color },
    })
    .returning({
      id: userCategories.id, name: userCategories.name, color: userCategories.color,
      icon: userCategories.icon, createdAt: userCategories.createdAt,
      // (xmax = 0) is Postgres's own "was this row just inserted, not
      // updated" tell -- same trick todo-tracker's upsertTodoBySource
      // already uses to know which branch of an ON CONFLICT fired.
      inserted: sql<boolean>`(xmax = 0)`,
    });

  await logDomainEvent(db, {
    userId: req.user!.userId, ownerType: "user_category", ownerId: String(row.id),
    action: row.inserted ? "created" : "updated",
    label: row.name, metadata: { color: row.color, icon: row.icon },
  });

  res.json({
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    createdAt: row.createdAt.toISOString(),
  });
});

// DELETE /categories/:id — delete a user category
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [deleted] = await db.delete(userCategories).where(
    and(eq(userCategories.id, id), eq(userCategories.userId, req.user!.userId))
  ).returning();

  if (deleted) {
    await logDomainEvent(db, {
      userId: req.user!.userId, ownerType: "user_category", ownerId: String(deleted.id), action: "deleted",
      label: deleted.name, metadata: { color: deleted.color, icon: deleted.icon },
    });
  }

  res.status(204).send();
});

export default router;
