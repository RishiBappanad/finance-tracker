// Single source of truth for category display colors. dashboard.tsx and
// spending/index.tsx each used to hardcode their own independent copy of
// this map -- dashboard's covered only 8 of the 19 real categories and had
// already drifted from spending's (e.g. missing "Gas & Fuel"), so the same
// category silently rendered a different color depending which page you
// were on. The category names themselves still come from the backend (see
// useListReceiptCategories / GET /transactions/categories,
// lib/categories.ts's getAllCategoryNames) -- this only maps a known name to
// a color; a category not listed here (including any user-created one,
// which can't have a color known ahead of time) falls back to DEFAULT_COLOR.
export const CATEGORY_COLORS: Record<string, string> = {
  "Food & Dining": "#ef4444",
  "Groceries": "#f97316",
  "Transportation": "#eab308",
  "Gas & Fuel": "#84cc16",
  "Shopping": "#22c55e",
  "Entertainment": "#14b8a6",
  "Health & Fitness": "#06b6d4",
  "Bills & Utilities": "#3b82f6",
  "Rent & Mortgage": "#6366f1",
  "Insurance": "#8b5cf6",
  "Travel": "#a855f7",
  "Education": "#d946ef",
  "Personal Care": "#ec4899",
  "Gifts & Donations": "#f43f5e",
  "Income": "#10b981",
  "Transfer": "#64748b",
  "Fees & Charges": "#dc2626",
  "Investment": "#059669",
  "Other": "#9ca3af",
  // Not one of getAllCategoryNames()'s user-selectable categories, but a real
  // backend-defined bucket name -- artifacts/api-server/src/lib/category-aggregation.ts's
  // UNCATEGORIZED constant, returned by the spending/earnings aggregation
  // endpoints for transactions with no category assigned. Keep this key in
  // sync with that constant's literal value, not just this comment.
  "Uncategorized": "#d4d4d8",
};

export const DEFAULT_CATEGORY_COLOR = "#9ca3af";

export function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLOR;
}

// Per-user color overrides, on top of the built-in defaults above --
// backed by PUT /categories/color (upserts a user_categories row keyed on
// (userId, name), whether that name is a default category or an existing
// custom one) and GET /categories (returns all of the user's rows, used
// here as the override source).
export function resolveCategoryColor(category: string, overrides: Record<string, string>): string {
  return overrides[category] ?? getCategoryColor(category);
}
