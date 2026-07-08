import { useState, useEffect } from "react";
import { CheckCircle2, EyeOff, Eye } from "lucide-react";
import { API_BASE, authFetch } from "@/lib/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  showBulkPrompt?: boolean;

  // Callbacks
  onIgnore?: (id: string, ignored: boolean) => void;
  onCategoryChanged?: () => void;
}

export function TransactionRow({
  transaction: txn,
  showAccountInfo = true,
  showCategoryPicker = false,
  showCategoryBadge = false,
  showIgnoreButton = false,
  showMatchIcon = true,
  showBulkPrompt = false,
  onIgnore,
  onCategoryChanged,
}: TransactionRowProps) {
  const [categories, setCategories] = useState<string[]>(_categoriesCache ?? []);
  const [localCategory, setLocalCategory] = useState(txn.userCategory);
  const [bulkDialog, setBulkDialog] = useState<{ category: string } | null>(null);

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
  }, [txn.userCategory]);

  const handleCategoryChange = async (category: string) => {
    setLocalCategory(category);
    try {
      await authFetch(`${API_BASE}/api/transactions/${txn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCategory: category }),
      });
      if (showBulkPrompt && hasMerchant) {
        setBulkDialog({ category });
      } else {
        onCategoryChanged?.();
      }
    } catch {
      setLocalCategory(txn.userCategory);
    }
  };

  const handleBulkAssign = async () => {
    if (!bulkDialog) return;
    try {
      await authFetch(`${API_BASE}/api/transactions/bulk-categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantName: txn.merchantName || txn.merchantNameRaw,
          userCategory: bulkDialog.category,
        }),
      });
    } catch {}
    setBulkDialog(null);
    onCategoryChanged?.();
  };

  const handleBulkSkip = () => {
    setBulkDialog(null);
    onCategoryChanged?.();
  };

  return (
    <>
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
          <Select value={localCategory || ""} onValueChange={handleCategoryChange}>
            <SelectTrigger className="w-[150px] h-8 text-xs shrink-0">
              <SelectValue placeholder="Assign category" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat} className="text-xs">
                  {cat}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Category badge (when no picker) */}
        {showCategoryBadge && !showCategoryPicker && localCategory && (
          <span className="text-xs bg-secondary px-2 py-0.5 rounded-full text-muted-foreground shrink-0">
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

      {/* Bulk assign dialog */}
      {showBulkPrompt && (
        <AlertDialog open={!!bulkDialog} onOpenChange={(open) => !open && handleBulkSkip()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Apply to all "{merchant}" transactions?</AlertDialogTitle>
              <AlertDialogDescription>
                Assign <strong>{bulkDialog?.category}</strong> to all transactions from this vendor, including past and future ones.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel onClick={handleBulkSkip}>Just this one</AlertDialogCancel>
              <AlertDialogAction onClick={handleBulkAssign}>Apply to all</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
