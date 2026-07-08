import { Router } from "express";
import { db } from "@workspace/db";
import { userCategories } from "@workspace/db";
import { eq, and } from "drizzle-orm";

const router = Router();

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

// DELETE /categories/:id — delete a user category
router.delete("/:id", async (req, res) => {
  const id = Number(req.params.id);
  await db.delete(userCategories).where(
    and(eq(userCategories.id, id), eq(userCategories.userId, req.user!.userId))
  );
  res.status(204).send();
});

export default router;
