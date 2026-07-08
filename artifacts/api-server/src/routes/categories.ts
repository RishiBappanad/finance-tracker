import { Router } from "express";
import { db } from "@workspace/db";
import { userCategories } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

// GET /categories — list all user-created categories
router.get("/", async (_req, res) => {
  const rows = await db
    .select()
    .from(userCategories)
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
      .values({ name: trimmedName, color: color || null, icon: icon || null })
      .returning();

    res.status(201).json({
      id: row.id,
      name: row.name,
      color: row.color,
      icon: row.icon,
      createdAt: row.createdAt.toISOString(),
    });
  } catch (e: any) {
    if (e.code === "23505") {
      return void res.status(409).json({ error: "Category already exists" });
    }
    throw e;
  }
});

// PATCH /categories/:id — update a user category
router.patch("/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { name, color, icon } = req.body;

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = name.trim();
  if (color !== undefined) updates.color = color;
  if (icon !== undefined) updates.icon = icon;

  if (Object.keys(updates).length === 0) {
    return void res.status(400).json({ error: "Nothing to update" });
  }

  const [row] = await db
    .update(userCategories)
    .set(updates)
    .where(eq(userCategories.id, id))
    .returning();

  if (!row) return void res.status(404).json({ error: "Category not found" });

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
  await db.delete(userCategories).where(eq(userCategories.id, id));
  res.status(204).send();
});

export default router;
