import { useState, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, PieChart as PieChartIcon, Sparkles, ArrowUpDown } from "lucide-react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TransactionRow, type TransactionData } from "@/components/transaction-row";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface CategoryData {
  category: string;
  total: number;
  count: number;
}

const CATEGORY_COLORS: Record<string, string> = {
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
};

type ViewMode = "spending" | "earnings";
type DrilldownSort = "date-desc" | "date-asc" | "amount-desc" | "amount-asc" | "merchant-asc";

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 1);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export default function CashFlow() {
  const defaults = getDefaultDateRange();
  const [mode, setMode] = useState<ViewMode>("spending");
  const [fromDate, setFromDate] = useState(defaults.from);
  const [toDate, setToDate] = useState(defaults.to);
  const [data, setData] = useState<CategoryData[] | null>(null);
  const [transactions, setTransactions] = useState<TransactionData[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [drilldownSort, setDrilldownSort] = useState<DrilldownSort>("date-desc");
  const [isLoading, setIsLoading] = useState(false);
  const [isCategorizing, setIsCategorizing] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const endpoint = mode === "spending"
    ? "/api/transactions/spending-by-category"
    : "/api/transactions/earnings-by-category";

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`http://localhost:5001${endpoint}?${params}`);
      setData(await res.json());
    } catch {
      toast({ title: "Error", description: "Could not load data", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchTransactionsForCategory = async (category: string) => {
    try {
      const params = new URLSearchParams({ from: fromDate, to: toDate });
      const res = await fetch(`http://localhost:5001/api/transactions?${params}`);
      const json: TransactionData[] = await res.json();
      // Filter by category and direction
      setTransactions(
        json.filter((t) =>
          t.userCategory === category &&
          (mode === "spending" ? t.amount > 0 : t.amount < 0)
        )
      );
    } catch {
      setTransactions([]);
    }
  };

  const handleCategorize = async () => {
    setIsCategorizing(true);
    try {
      const res = await fetch("http://localhost:5001/api/transactions/categorize", { method: "POST" });
      const result = await res.json();
      toast({
        title: "Categorization complete",
        description: `Categorized ${result.categorized} of ${result.total} transactions`,
      });
      await fetchData();
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
    } catch {
      toast({ title: "Error", description: "Categorization failed", variant: "destructive" });
    } finally {
      setIsCategorizing(false);
    }
  };

  const handleIgnore = async (txnId: string, ignored: boolean) => {
    try {
      await fetch(`http://localhost:5001/api/transactions/${txnId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ignored }),
      });
      setTransactions((prev) => prev.filter((t) => t.id !== txnId));
      await fetchData();
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
    } catch {
      toast({ title: "Error", description: "Failed to update transaction", variant: "destructive" });
    }
  };

  // Fetch on mount, date change, or mode change
  useEffect(() => {
    fetchData();
    setSelectedCategory(null);
  }, [fromDate, toDate, mode]);

  // Fetch transactions when category selected
  useEffect(() => {
    if (selectedCategory) {
      fetchTransactionsForCategory(selectedCategory);
    } else {
      setTransactions([]);
    }
  }, [selectedCategory, fromDate, toDate, mode]);

  // Sort drill-down
  const sortedTransactions = useMemo(() => {
    const list = [...transactions];
    switch (drilldownSort) {
      case "date-desc": return list.sort((a, b) => b.date.localeCompare(a.date));
      case "date-asc": return list.sort((a, b) => a.date.localeCompare(b.date));
      case "amount-desc": return list.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      case "amount-asc": return list.sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
      case "merchant-asc": return list.sort((a, b) => {
        const ma = (a.merchantName || a.merchantNameRaw || "").toLowerCase();
        const mb = (b.merchantName || b.merchantNameRaw || "").toLowerCase();
        return ma.localeCompare(mb);
      });
      default: return list;
    }
  }, [transactions, drilldownSort]);

  const total = data?.reduce((sum, d) => sum + d.total, 0) ?? 0;
  const chartData = data?.filter((d) => d.total > 0).sort((a, b) => b.total - a.total) ?? [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Cash Flow</h1>
          <p className="text-muted-foreground mt-1 text-sm">Track where your money goes and where it comes from.</p>
        </div>
        <Button
          className="shrink-0 shadow-sm"
          onClick={handleCategorize}
          disabled={isCategorizing}
        >
          {isCategorizing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
          Categorize Transactions
        </Button>
      </div>

      {/* Mode toggle + Date range */}
      <Card className="p-4 border-none shadow-sm space-y-3">
        {/* Spending / Earnings toggle */}
        <div className="flex items-center gap-1 p-1 bg-secondary/40 rounded-lg w-fit">
          <button
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              mode === "spending"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setMode("spending")}
          >
            Spending
          </button>
          <button
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              mode === "earnings"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setMode("earnings")}
          >
            Earnings
          </button>
        </div>

        {/* Date range */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-muted-foreground">From</label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-auto bg-secondary/30 border-transparent"
          />
          <label className="text-sm font-medium text-muted-foreground">To</label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-auto bg-secondary/30 border-transparent"
          />
          <div className="flex gap-2 ml-auto">
            {[
              { label: "1W", days: 7 },
              { label: "1M", days: 30 },
              { label: "3M", days: 90 },
              { label: "6M", days: 180 },
              { label: "1Y", days: 365 },
            ].map(({ label, days }) => (
              <Button
                key={label}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  const to = new Date();
                  const from = new Date();
                  from.setDate(from.getDate() - days);
                  setFromDate(from.toISOString().slice(0, 10));
                  setToDate(to.toISOString().slice(0, 10));
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* Main content */}
      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : chartData.length === 0 ? (
        <Card className="border-dashed border-2 shadow-none bg-transparent">
          <div className="p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <PieChartIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">
              No categorized {mode} yet
            </h3>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              Click "Categorize Transactions" to auto-assign categories, then view your {mode} breakdown.
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Pie Chart */}
          <Card className="p-6 border-none shadow-sm">
            <h2 className="font-semibold mb-4">
              {mode === "spending" ? "Spending" : "Earnings"} Distribution
            </h2>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={chartData}
                    dataKey="total"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    outerRadius={110}
                    innerRadius={55}
                    paddingAngle={2}
                    onClick={(_, idx) => setSelectedCategory(chartData[idx]?.category ?? null)}
                    style={{ cursor: "pointer" }}
                  >
                    {chartData.map((entry) => (
                      <Cell
                        key={entry.category}
                        fill={CATEGORY_COLORS[entry.category] ?? "#9ca3af"}
                        opacity={selectedCategory && selectedCategory !== entry.category ? 0.4 : 1}
                      />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => [`$${value.toFixed(2)}`, "Amount"]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {selectedCategory && (
              <p className="text-center text-sm text-muted-foreground mt-2">
                Showing: <span className="font-medium text-foreground">{selectedCategory}</span>
                <Button variant="link" size="sm" className="ml-1 h-auto p-0 text-xs" onClick={() => setSelectedCategory(null)}>
                  Clear
                </Button>
              </p>
            )}
          </Card>

          {/* Category Breakdown List */}
          <Card className="border-none shadow-sm overflow-hidden">
            <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
              <h2 className="font-semibold">Category Breakdown</h2>
              <span className="text-sm font-mono text-muted-foreground">
                Total: ${total.toFixed(2)}
              </span>
            </div>
            <div className="divide-y divide-border max-h-[350px] overflow-y-auto">
              {chartData.map((item) => {
                const pct = total > 0 ? (item.total / total) * 100 : 0;
                const isSelected = selectedCategory === item.category;
                return (
                  <div
                    key={item.category}
                    className={`p-4 flex items-center gap-3 cursor-pointer transition-colors ${isSelected ? "bg-secondary/30" : "hover:bg-secondary/10"}`}
                    onClick={() => setSelectedCategory(isSelected ? null : item.category)}
                  >
                    <div
                      className="h-3 w-3 rounded-full shrink-0"
                      style={{ backgroundColor: CATEGORY_COLORS[item.category] ?? "#9ca3af" }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-center">
                        <span className="text-sm font-medium truncate">{item.category}</span>
                        <span className="text-sm font-mono">${item.total.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${pct}%`,
                              backgroundColor: CATEGORY_COLORS[item.category] ?? "#9ca3af",
                            }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {pct.toFixed(1)}% • {item.count} txns
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* Drill-down */}
      {selectedCategory && sortedTransactions.length > 0 && (
        <Card className="border-none shadow-sm overflow-hidden">
          <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold">{selectedCategory}</h2>
              <span className="text-xs font-mono bg-secondary px-2 py-1 rounded-full">
                {sortedTransactions.length} transactions
              </span>
            </div>
            <Select value={drilldownSort} onValueChange={(v) => setDrilldownSort(v as DrilldownSort)}>
              <SelectTrigger className="w-[160px] h-8 text-xs bg-secondary/30 border-transparent">
                <ArrowUpDown className="h-3 w-3 mr-1.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date-desc" className="text-xs">Newest first</SelectItem>
                <SelectItem value="date-asc" className="text-xs">Oldest first</SelectItem>
                <SelectItem value="amount-desc" className="text-xs">Highest amount</SelectItem>
                <SelectItem value="amount-asc" className="text-xs">Lowest amount</SelectItem>
                <SelectItem value="merchant-asc" className="text-xs">Merchant A→Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="divide-y divide-border max-h-[400px] overflow-y-auto">
            {sortedTransactions.map((txn) => (
              <TransactionRow
                key={txn.id}
                transaction={txn}
                showAccountInfo
                showCategoryPicker
                showIgnoreButton
                showBulkPrompt
                onIgnore={handleIgnore}
                onCategoryChanged={() => {
                  fetchData();
                  if (selectedCategory) fetchTransactionsForCategory(selectedCategory);
                }}
              />
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
