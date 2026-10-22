import { useState, useEffect } from "react";
import { CheckCircle2, EyeOff, Eye, Users, Loader2, Sparkles, Check } from "lucide-react";
import { API_BASE, authFetch } from "@/lib/api";
import { CategoryCombobox } from "@/components/category-combobox";
import { Button } from "@/components/ui/button";

export interface TransactionData {
  id: string;
  accountId: string;
  accountName?: string | null;
  accountMask?: string | null;
  amount: number;
  currency: string;
  merchantName: string | null;
  merchantNameRaw: string | null;
  categoryPrimary: string | null;
  categoryDetail: string | null;
  userCategory: string | null;
  // True when `userCategory` was assigned by the categorizer (passively on
  // sync, or via the manual "Categorize" button) and hasn't been confirmed
  // or changed by the user yet -- lets the row flag it as a guess rather
  // than presenting it as something the user picked.
  categoryAutoAssigned?: boolean;
  ignored?: boolean;
  date: string;
  pending: boolean;
  matchId?: number | null;
}

// ── Category cache (module-level, shared across all rows) ────────────────────
let _categoriesCache: string[] | null = null;
let _categoriesFetching = false;
const _categoryListeners: Array<(cats: string[]) => void> = [];

async function getCategories(): Promise<string[]> {
  if (_categoriesCache) return _categoriesCache;
  if (_categoriesFetching) {
    return new Promise((resolve) => {
      _categoryListeners.push(resolve);
    });
  }
  _categoriesFetching = true;
  try {
    const res = await authFetch(`${API_BASE}/api/transactions/categories`);
    const cats = await res.json();
    _categoriesCache = cats;
    _categoryListeners.forEach((cb) => cb(cats));
    _categoryListeners.length = 0;
    return cats;
  } catch {
    _categoriesFetching = false;
    return [];
  }
}

export function invalidateCategoriesCache() {
  _categoriesCache = null;
  _categoriesFetching = false;
}

// ── Feature-flag props ───────────────────────────────────────────────────────
interface TransactionRowProps {
  transaction: TransactionData;

  // Feature flags — each page picks what it needs
  showAccountInfo?: boolean;
  showCategoryPicker?: boolean;
  showCategoryBadge?: boolean;
  showIgnoreButton?: boolean;
  showMatchIcon?: boolean;
  // Offers an "Apply to all" action next to the category picker, letting
  // the user opt into bulk-assigning this category to every transaction
  // from the same merchant -- a plain button clicked only when the bulk
  // behavior is actually wanted, rather than an AlertDialog interrupting
  // every single category change.
  showBulkApply?: boolean;

  // Callbacks
  onIgnore?: (id: string, ignored: boolean) => void;
  onCategoryChanged?: () => void;
  onBulkApplied?: (result: { updated: number; merchantName: string; userCategory: string }) => void;
}

export function TransactionRow({
  transaction: txn,
  showAccountInfo = true,
  showCategoryPicker = false,
  showCategoryBadge = false,
  showIgnoreButton = false,
  showMatchIcon = true,
  showBulkApply = false,
  onIgnore,
  onCategoryChanged,
  onBulkApplied,
}: TransactionRowProps) {
  const [categories, setCategories] = useState<string[]>(_categoriesCache ?? []);
  const [localCategory, setLocalCategory] = useState(txn.userCategory);
  const [autoAssigned, setAutoAssigned] = useState(txn.categoryAutoAssigned ?? false);
  const [isBulkApplying, setIsBulkApplying] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  const merchant = txn.merchantName || txn.merchantNameRaw || "(No merchant)";
  const hasMerchant = !!(txn.merchantName || txn.merchantNameRaw);
  const isCredit = txn.amount < 0;
  const displayAmount = `${isCredit ? "+" : "-"}$${Math.abs(txn.amount).toFixed(2)}`;

  useEffect(() => {
    if (showCategoryPicker && !_categoriesCache) {
      getCategories().then(setCategories);
    } else if (_categoriesCache) {
      setCategories(_categoriesCache);
    }
  }, [showCategoryPicker]);

  useEffect(() => {
    setLocalCategory(txn.userCategory);
    setAutoAssigned(txn.categoryAutoAssigned ?? false);
  }, [txn.userCategory, txn.categoryAutoAssigned]);

  const handleCategoryChange = async (category: string) => {
    const prevCategory = localCategory;
    const prevAutoAssigned = autoAssigned;
    setLocalCategory(category);
    setAutoAssigned(false);
    try {
      await authFetch(`${API_BASE}/api/transactions/${txn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCategory: category }),
      });
      onCategoryChanged?.();
    } catch {
      setLocalCategory(prevCategory);
      setAutoAssigned(prevAutoAssigned);
    }
  };

  // Confirms the categorizer's guess as-is, without changing it -- same
  // PATCH endpoint as an actual category change, just resubmitting the
  // current value, which is enough for the backend to clear the
  // auto-assigned flag.
  const handleConfirmCategory = async () => {
    if (!localCategory) return;
    setIsConfirming(true);
    setAutoAssigned(false);
    try {
      await authFetch(`${API_BASE}/api/transactions/${txn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCategory: localCategory }),
      });
      onCategoryChanged?.();
    } catch {
      setAutoAssigned(true);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleApplyToAll = async () => {
    if (!localCategory || !hasMerchant) return;
    setIsBulkApplying(true);
    try {
      const res = await authFetch(`${API_BASE}/api/transactions/bulk-categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantName: merchant, userCategory: localCategory }),
      });
      const result = await res.json();
      onBulkApplied?.(result);
    } finally {
      setIsBulkApplying(false);
    }
  };

  return (
    <div className={`flex items-center justify-between p-4 hover:bg-secondary/20 transition-colors gap-3 ${txn.ignored ? "opacity-50" : ""}`}>
      {/* Left: merchant + metadata */}
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-sm font-medium text-foreground truncate">{merchant}</span>
        <span className="text-xs text-muted-foreground">
          {txn.date}
          {showAccountInfo && txn.accountName && ` • ${txn.accountName}`}
          {showAccountInfo && txn.accountMask && ` ••${txn.accountMask}`}
        </span>
      </div>

      {/* Category picker */}
      {showCategoryPicker && categories.length > 0 && (
        <div className="flex items-center gap-1 shrink-0">
          <CategoryCombobox
            categories={categories}
            value={localCategory}
            onChange={handleCategoryChange}
            placeholder="Assign category"
            triggerClassName="w-[150px] h-8"
          />
          {autoAssigned && localCategory && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={handleConfirmCategory}
              disabled={isConfirming}
              title={`Auto-categorized as "${localCategory}" — confirm it's correct`}
            >
              {isConfirming ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
              )}
            </Button>
          )}
          {showBulkApply && hasMerchant && localCategory && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={handleApplyToAll}
              disabled={isBulkApplying}
              title={`Apply "${localCategory}" to all "${merchant}" transactions`}
            >
              {isBulkApplying ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : (
                <Users className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </Button>
          )}
        </div>
      )}

      {/* Category badge (when no picker) */}
      {showCategoryBadge && !showCategoryPicker && localCategory && (
        <span
          className="flex items-center gap-1 text-xs bg-secondary px-2 py-0.5 rounded-full text-muted-foreground shrink-0"
          title={autoAssigned ? `Auto-categorized as "${localCategory}" — not yet confirmed` : undefined}
        >
          {autoAssigned && <Sparkles className="h-3 w-3 text-amber-500" />}
          {localCategory}
        </span>
      )}

      {/* Right: actions + amount */}
      <div className="flex items-center gap-2 shrink-0">
        {showIgnoreButton && onIgnore && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onIgnore(txn.id, !txn.ignored)}
            title={txn.ignored ? "Include in spending" : "Ignore from spending"}
          >
            {txn.ignored ? (
              <Eye className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </Button>
        )}

        {showMatchIcon && txn.matchId && (
          <CheckCircle2 className="h-4 w-4 text-green-500" />
        )}

        <span className={`text-sm font-mono font-medium w-20 text-right ${isCredit ? "text-green-600" : "text-foreground"}`}>
          {displayAmount}
        </span>
      </div>
    </div>
  );
}
