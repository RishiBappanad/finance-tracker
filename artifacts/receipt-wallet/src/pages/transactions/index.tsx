import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeftRight, RefreshCw, Search, Loader2, Plus, ArrowUpDown, Filter, X, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { TransactionRow, invalidateCategoriesCache, type TransactionData } from "@/components/transaction-row";
import { DayNavigator, todayIso, weekBounds, friendlyDate } from "@/components/day-navigator";
import { API_BASE, authFetch } from "@/lib/api";
import { useListTransactions, useListAccounts, syncTransactions } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

type SortOption = "date-desc" | "date-asc" | "merchant-asc" | "merchant-desc";
type ViewMode = "all" | "day";
const PAGE_SIZE = 50;

// The Daily view keeps its date in the URL (?date=YYYY-MM-DD), like
// nutrition-insights' dashboard, so a reload or a shared link lands on the same
// day. Read once for the initial state; kept in sync by an effect below.
function initialDayFromUrl(): string | null {
  const value = new URLSearchParams(window.location.search).get("date");
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

export default function Transactions() {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("date-desc");
  const [isSyncing, setIsSyncing] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [hiddenTxns, setHiddenTxns] = useState<TransactionData[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // All transactions (the original list) or one day at a time
  const [initialDay] = useState(initialDayFromUrl);
  const [view, setView] = useState<ViewMode>(initialDay ? "day" : "all");
  const [date, setDate] = useState(initialDay ?? todayIso());

  // Filters
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterVendors, setFilterVendors] = useState<string[]>([]);
  const [filterAccounts, setFilterAccounts] = useState<string[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  // Dynamic filter options
  const [vendors, setVendors] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const { data: accountsList } = useListAccounts();

  // Daily view asks the API for the selected date's whole week (one request), so
  // the week strip can show every day's spend and switching days inside the week
  // needs no new fetch; the list itself is narrowed to the selected day below.
  const week = useMemo(() => weekBounds(date), [date]);
  const { data: transactions, isLoading } = useListTransactions(
    {
      ...(search ? { search } : {}),
      ...(view === "day"
        ? { from: week.start, to: week.end }
        : { ...(fromDate ? { from: fromDate } : {}), ...(toDate ? { to: toDate } : {}) }),
    }
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch filter options
  useEffect(() => {
    authFetch(`${API_BASE}/api/transactions/vendors`)
      .then((r) => r.json())
      .then(setVendors)
      .catch(() => {});
    authFetch(`${API_BASE}/api/transactions/categories`)
      .then((r) => r.json())
      .then(setCategories)
      .catch(() => {});
  }, []);

  // Fetch hidden transactions when toggle is on
  useEffect(() => {
    if (showHidden) {
      authFetch(`${API_BASE}/api/transactions/ignored`)
        .then((r) => r.json())
        .then(setHiddenTxns)
        .catch(() => {});
    }
  }, [showHidden]);

  // Keep ?date= in step with the Daily view (and drop it for the full list).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (view === "day") url.searchParams.set("date", date);
    else url.searchParams.delete("date");
    window.history.replaceState(window.history.state, "", url);
  }, [view, date]);

  // Every category ticked is the same as none ticked -- no restriction --
  // so "Select all" can't start hiding uncategorized transactions.
  const restrictsCategories = filterCategories.length > 0 && !(categories.length > 0 && categories.every((c) => filterCategories.includes(c)));

  // Client-side filters + sort
  const baseFiltered = useMemo(() => {
    let list = [...(transactions ?? [])];

    if (restrictsCategories) {
      list = list.filter((t: any) => filterCategories.includes(t.userCategory));
    }
    if (filterVendors.length > 0) {
      list = list.filter((t: any) =>
        filterVendors.some((v) =>
          (t.merchantName || t.merchantNameRaw || "").toLowerCase() === v.toLowerCase()
        )
      );
    }
    if (filterAccounts.length > 0) {
      list = list.filter((t: any) => filterAccounts.includes(t.accountName));
    }

    switch (sort) {
      case "date-desc":
        list.sort((a: any, b: any) => b.date.localeCompare(a.date));
        break;
      case "date-asc":
        list.sort((a: any, b: any) => a.date.localeCompare(b.date));
        break;
      case "merchant-asc":
        list.sort((a: any, b: any) => {
          const ma = (a.merchantName || a.merchantNameRaw || "").toLowerCase();
          const mb = (b.merchantName || b.merchantNameRaw || "").toLowerCase();
          return ma.localeCompare(mb);
        });
        break;
      case "merchant-desc":
        list.sort((a: any, b: any) => {
          const ma = (a.merchantName || a.merchantNameRaw || "").toLowerCase();
          const mb = (b.merchantName || b.merchantNameRaw || "").toLowerCase();
          return mb.localeCompare(ma);
        });
        break;
    }

    return list;
  }, [transactions, restrictsCategories, filterCategories, filterVendors, filterAccounts, sort]);

  // Daily view: the selected day's rows, its summary, and each week day's spend.
  // Positive amounts are money out, negative are credits (the app-wide convention).
  const filtered = useMemo(
    () => (view === "day" ? baseFiltered.filter((t: any) => t.date === date) : baseFiltered),
    [baseFiltered, view, date]
  );

  const weekSpend = useMemo(() => {
    const totals: Record<string, number> = {};
    if (view !== "day") return totals;
    for (const t of baseFiltered as any[]) if (t.amount > 0) totals[t.date] = (totals[t.date] ?? 0) + t.amount;
    return totals;
  }, [baseFiltered, view]);

  const daySummary = useMemo(() => {
    if (view !== "day") return null;
    let spent = 0;
    let credits = 0;
    const byCategory: Record<string, number> = {};
    for (const t of filtered as any[]) {
      if (t.amount > 0) {
        spent += t.amount;
        const key = t.userCategory || "Uncategorized";
        byCategory[key] = (byCategory[key] ?? 0) + t.amount;
      } else {
        credits += -t.amount;
      }
    }
    const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 4);
    return { spent, credits, count: filtered.length, top };
  }, [filtered, view]);

  // Lazy loading — show more on scroll
  const visibleTransactions = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
      setVisibleCount((prev) => Math.min(prev + PAGE_SIZE, filtered.length));
    }
  }, [filtered.length]);

  // Reset visible count when filters change
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [search, fromDate, toDate, filterCategories, filterVendors, filterAccounts, sort, view, date]);

  const hasActiveFilters = !!(fromDate || toDate || restrictsCategories || filterVendors.length || filterAccounts.length);

  const clearFilters = () => {
    setFromDate("");
    setToDate("");
    setFilterCategories([]);
    setFilterVendors([]);
    setFilterAccounts([]);
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const result = await syncTransactions();
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      toast({
        title: "Sync complete",
        description: `Added ${result.added} transactions, updated ${result.updated}, removed ${result.removed}.`,
      });
      authFetch(`${API_BASE}/api/transactions/vendors`)
        .then((r) => r.json())
        .then(setVendors)
        .catch(() => {});
    } catch {
      toast({ title: "Sync failed", description: "Could not sync transactions from bank.", variant: "destructive" });
    } finally {
      setIsSyncing(false);
    }
  };

  const handleCreateCategory = async () => {
    if (!newCategoryName.trim()) return;
    try {
      const res = await authFetch(`${API_BASE}/api/categories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newCategoryName.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast({ title: "Error", description: err.error, variant: "destructive" });
        return;
      }
      toast({ title: "Category created", description: newCategoryName.trim() });
      setNewCategoryName("");
      setDialogOpen(false);
      invalidateCategoriesCache();
      authFetch(`${API_BASE}/api/transactions/categories`)
        .then((r) => r.json())
        .then(setCategories)
        .catch(() => {});
    } catch {
      toast({ title: "Error", description: "Failed to create category", variant: "destructive" });
    }
  };

  const handleUnignore = async (id: string) => {
    await authFetch(`${API_BASE}/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignored: false }),
    });
    setHiddenTxns((prev) => prev.filter((t) => t.id !== id));
    queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      {/* Sticky header */}
      <div className="flex-shrink-0 space-y-4 pb-4">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">Transactions</h1>
            <p className="text-muted-foreground mt-1 text-sm">Every bank transaction, ready to be justified.</p>
          </div>
          <div className="flex gap-2">
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" className="shrink-0 shadow-sm bg-card hover:bg-secondary">
                  <Plus className="h-4 w-4 mr-2" />
                  New Category
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Custom Category</DialogTitle>
                </DialogHeader>
                <div className="flex gap-2 mt-4">
                  <Input
                    placeholder="Category name..."
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleCreateCategory()}
                  />
                  <Button onClick={handleCreateCategory} disabled={!newCategoryName.trim()}>
                    Create
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
            <Button
              variant="outline"
              className="shrink-0 shadow-sm bg-card hover:bg-secondary"
              onClick={handleSync}
              disabled={isSyncing}
            >
              {isSyncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />}
              Sync Latest
            </Button>
          </div>
        </div>

        {/* Search + sort + filter toggle */}
        <Card className="p-4 border-none shadow-sm space-y-3">
          <div className="flex items-center gap-1 p-1 bg-secondary/40 rounded-lg w-fit">
            {([["all", "All transactions"], ["day", "Daily"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                  view === mode ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                }`}
                onClick={() => setView(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          {view === "day" && <DayNavigator date={date} onChange={setDate} weekSpend={weekSpend} />}

          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search merchants or amounts..."
                className="pl-9 bg-secondary/30 border-transparent focus-visible:bg-background transition-colors"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger className="w-[170px] bg-secondary/30 border-transparent">
                <ArrowUpDown className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc">Newest first</SelectItem>
                <SelectItem value="date-asc">Oldest first</SelectItem>
                <SelectItem value="merchant-asc">Merchant A→Z</SelectItem>
                <SelectItem value="merchant-desc">Merchant Z→A</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant={showFilters ? "secondary" : "outline"}
              className="shrink-0"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="h-4 w-4 mr-2" />
              Filters
              {hasActiveFilters && (
                <span className="ml-1.5 h-4 w-4 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center">
                  {[fromDate, toDate, restrictsCategories, filterVendors.length, filterAccounts.length].filter(Boolean).length}
                </span>
              )}
            </Button>
            <Button
              variant={showHidden ? "secondary" : "ghost"}
              size="sm"
              className="shrink-0"
              onClick={() => setShowHidden(!showHidden)}
            >
              <EyeOff className="h-4 w-4 mr-2" />
              Hidden ({hiddenTxns.length || "…"})
            </Button>
          </div>

          {/* Expanded filter controls */}
          {showFilters && (
            <div className="flex flex-wrap gap-3 pt-2 border-t border-border">
              {view === "all" && (<>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">From</label>
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-auto h-8 text-xs bg-secondary/30 border-transparent"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-muted-foreground">To</label>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-auto h-8 text-xs bg-secondary/30 border-transparent"
                />
              </div>
              </>)}
              <MultiSelectFilter
                label="All categories"
                options={categories}
                selected={filterCategories}
                onChange={setFilterCategories}
                className="w-[160px]"
              />
              <MultiSelectFilter
                label="All vendors"
                options={vendors}
                selected={filterVendors}
                onChange={setFilterVendors}
                className="w-[160px]"
              />
              <MultiSelectFilter
                label="All accounts"
                options={(accountsList ?? []).map((a: any) => a.name).filter(Boolean)}
                selected={filterAccounts}
                onChange={setFilterAccounts}
                className="w-[160px]"
              />
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                  <X className="h-3 w-3 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          )}
        </Card>

        {daySummary && (
          <Card className="p-4 border-none shadow-sm">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <p className="text-xs text-muted-foreground">Spent</p>
                <p className="text-xl font-semibold font-mono">${daySummary.spent.toFixed(2)}</p>
              </div>
              {daySummary.credits > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground">Credits</p>
                  <p className="text-xl font-semibold font-mono text-emerald-600">+${daySummary.credits.toFixed(2)}</p>
                </div>
              )}
              <div>
                <p className="text-xs text-muted-foreground">Transactions</p>
                <p className="text-xl font-semibold font-mono">{daySummary.count}</p>
              </div>
              {daySummary.top.length > 0 && (
                <div className="flex flex-wrap gap-1.5 ml-auto">
                  {daySummary.top.map(([category, total]) => (
                    <span key={category} className="text-xs px-2 py-1 rounded-full bg-secondary/60">
                      {category} <span className="font-mono text-muted-foreground">${total.toFixed(0)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </Card>
        )}
      </div>

      {/* Hidden transactions panel */}
      {showHidden && hiddenTxns.length > 0 && (
        <Card className="flex-shrink-0 border-none shadow-sm overflow-hidden mb-4">
          <div className="p-3 border-b border-border bg-amber-50 dark:bg-amber-950/20 flex justify-between items-center">
            <span className="text-sm font-medium">Hidden Transactions</span>
            <span className="text-xs text-muted-foreground">{hiddenTxns.length} hidden</span>
          </div>
          <div className="max-h-[200px] overflow-y-auto divide-y divide-border">
            {hiddenTxns.map((txn) => (
              <TransactionRow
                key={txn.id}
                transaction={txn}
                showAccountInfo
                showCategoryBadge
                showIgnoreButton
                onIgnore={() => handleUnignore(txn.id)}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Scrollable transaction list with lazy loading */}
      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed border-2 shadow-none bg-transparent">
          <div className="p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <ArrowLeftRight className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">
              {view === "day"
                ? `Nothing on ${friendlyDate(date)}`
                : hasActiveFilters ? "No transactions match filters" : "No transactions synced"}
            </h3>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              {view === "day"
                ? hasActiveFilters ? "No transactions that day match your filters." : "No transactions were recorded that day. Use the arrows or the week strip to look at another day."
                : hasActiveFilters
                ? "Try adjusting your filters or clearing them."
                : "Connect a bank account and click \"Sync Latest\" to import your transactions."}
            </p>
            {hasActiveFilters && (
              <Button variant="outline" className="mt-4" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <Card className="border-none shadow-sm overflow-hidden flex-1 min-h-0 flex flex-col">
          <div className="px-4 py-2 border-b border-border bg-secondary/10 text-xs text-muted-foreground">
            {filtered.length} transaction{filtered.length !== 1 ? "s" : ""}
            {hasActiveFilters && " (filtered)"}
            {visibleCount < filtered.length && ` • showing ${visibleCount}`}
          </div>
          <div className="flex-1 overflow-y-auto" ref={scrollRef} onScroll={handleScroll}>
            <div className="divide-y divide-border">
              {visibleTransactions.map((txn: any) => (
                <TransactionRow
                  key={txn.id}
                  transaction={txn}
                  showAccountInfo
                  showCategoryPicker
                  showBulkApply
                  showMatchIcon
                  onCategoryChanged={() => queryClient.invalidateQueries({ queryKey: ["/api/transactions"] })}
                  onBulkApplied={(result) => {
                    toast({
                      title: "Category applied",
                      description: `Set "${result.userCategory}" on ${result.updated} transaction${result.updated === 1 ? "" : "s"} from ${result.merchantName}.`,
                    });
                    queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
                  }}
                />
              ))}
            </div>
            {visibleCount < filtered.length && (
              <div className="p-4 text-center text-xs text-muted-foreground">
                Scroll for more…
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
