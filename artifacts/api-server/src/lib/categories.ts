/**
 * Canonical spending category list — shared by transactions AND receipt
 * items. Both used to have their own separate, differently-named category
 * lists (transactions: "Gas & Fuel", receipt items: "Gas"), which meant an
 * item's category could never actually match anything transactions or
 * cash-flow reporting understood. This is the single source of truth for
 * "what counts as a valid category" across the whole app.
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
