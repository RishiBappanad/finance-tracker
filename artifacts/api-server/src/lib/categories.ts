/**
 * Canonical spending category list — shared by transactions AND receipt
 * items, so an item's category always matches what cash-flow reporting
 * understands. The single source of truth for "what counts as a valid
 * category" across the whole app.
 */
import { db } from "@workspace/db";
import { userCategories } from "@workspace/db";
import { CATEGORIES } from "../services/categorizer.js";

export async function getAllCategoryNames(): Promise<string[]> {
  const userCats = await db.select({ name: userCategories.name }).from(userCategories).orderBy(userCategories.name);
  const userCatNames = userCats.map((c) => c.name);
  // Defaults first, then user-created (deduped in case a user recreated a default name)
  return [...CATEGORIES, ...userCatNames.filter((n) => !CATEGORIES.includes(n as any))];
}

export async function isValidCategoryName(name: string): Promise<boolean> {
  const all = await getAllCategoryNames();
  return all.includes(name);
}
