import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Receipt, Wallet, AlertCircle, ArrowRightLeft, TrendingUp, Building2 } from "lucide-react";
import { Link } from "wouter";
import { TransactionRow, type TransactionData } from "@/components/transaction-row";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { useListAccounts } from "@workspace/api-client-react";
import { API_BASE, authFetch } from "@/lib/api";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface DashboardSummary {
  totalReceipts: number;
  matchedReceipts: number;
  unmatchedReceipts: number;
  totalTransactions: number;
  expiringReturns: number;
  totalSpendThisMonth: number;
  pendingReconciliation: number;
}

interface SpendingPoint {
  date: string;
  category: string;
  total: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  "Food & Dining": "#ef4444",
  "Groceries": "#f97316",
  "Transportation": "#eab308",
  "Shopping": "#22c55e",
  "Entertainment": "#14b8a6",
  "Bills & Utilities": "#3b82f6",
  "Travel": "#a855f7",
  "Other": "#9ca3af",
};

function formatCurrency(amount: number | null | undefined) {
  if (amount == null) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [recentTxns, setRecentTxns] = useState<TransactionData[]>([]);
  const [chartData, setChartData] = useState<any[]>([]);
  const [chartCategories, setChartCategories] = useState<string[]>([]);
  const [cumulative, setCumulative] = useState(false);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterAccounts, setFilterAccounts] = useState<string[]>([]);
  const [allChartCategories, setAllChartCategories] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { data: accounts } = useListAccounts();

  useEffect(() => {
    async function fetchDashboard() {
      try {
        const [summaryRes, txnRes] = await Promise.all([
          authFetch(`${API_BASE}/api/dashboard/summary`),
          authFetch(`${API_BASE}/api/transactions?from=${getMonthAgo()}`),
        ]);
        const summaryData = await summaryRes.json();
        const txnData: TransactionData[] = await txnRes.json();
        setSummary(summaryData);
        // Sort by date descending to get most recent first
        txnData.sort((a, b) => b.date.localeCompare(a.date));
        setRecentTxns(txnData.slice(0, 8));
      } catch {}
      finally { setIsLoading(false); }
    }
    fetchDashboard();
  }, []);

  useEffect(() => {
    fetchChartData();
  }, [cumulative, filterCategories, filterAccounts]);

  async function fetchChartData() {
    try {
      const params = new URLSearchParams({
        from: getMonthAgo(),
        to: new Date().toISOString().slice(0, 10),
        cumulative: cumulative ? "true" : "false",
      });
      if (filterAccounts.length > 0) {
        params.set("accounts", filterAccounts.join(","));
      }
      const res = await authFetch(`${API_BASE}/api/dashboard/spending-over-time?${params}`);
      const rows: SpendingPoint[] = await res.json();

      // Pivot into [{date, Cat1: amt, Cat2: amt}]
      const dateMap: Record<string, Record<string, number>> = {};
      const cats = new Set<string>();

      for (const row of rows) {
        if (!dateMap[row.date]) dateMap[row.date] = {};
        dateMap[row.date][row.category] = row.total;
        cats.add(row.category);
      }

      const allCats = [...cats].sort();
      setAllChartCategories(allCats);

      // Apply client-side category filter for the chart lines
      const visibleCats = filterCategories.length > 0
        ? allCats.filter((c) => filterCategories.includes(c))
        : allCats.slice(0, 8);

      const pivoted = Object.entries(dateMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, vals]) => ({ date: date.slice(5), ...vals })); // Show MM-DD

      setChartData(pivoted);
      setChartCategories(visibleCats);
    } catch {}
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </div>
    );
  }

  const s = summary ?? {
    totalReceipts: 0, matchedReceipts: 0, unmatchedReceipts: 0,
    totalTransactions: 0, expiringReturns: 0, totalSpendThisMonth: 0,
    pendingReconciliation: 0,
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-1 text-sm">Your financial cockpit. Precision tracking for every dollar.</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Spend This Month</CardTitle>
            <TrendingUp className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(s.totalSpendThisMonth)}</div>
            <p className="text-xs text-muted-foreground mt-1">{s.totalTransactions} total transactions</p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Linked Accounts</CardTitle>
            <Building2 className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">{accounts?.length ?? 0}</div>
            <p className="text-xs text-muted-foreground mt-1">
              <Link href="/accounts" className="text-primary hover:underline">Manage accounts</Link>
            </p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unmatched Receipts</CardTitle>
            <Receipt className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">{s.unmatchedReceipts}</div>
            <p className="text-xs text-muted-foreground mt-1">{s.matchedReceipts} of {s.totalReceipts} matched</p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expiring Returns</CardTitle>
            <AlertCircle className={`h-4 w-4 ${s.expiringReturns > 0 ? "text-destructive" : "text-muted-foreground"}`} />
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold tracking-tight ${s.expiringReturns > 0 ? "text-destructive" : ""}`}>
              {s.expiringReturns}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Window closing within 14 days</p>
          </CardContent>
        </Card>
      </div>

      {/* Spending Over Time Chart */}
      {chartData.length > 0 && (
        <Card className="border-none shadow-sm p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold tracking-tight">Spending Over Time</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Last 30 days by category</p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-secondary/40 rounded-lg">
              <button
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${!cumulative ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setCumulative(false)}
              >
                Daily
              </button>
              <button
                className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${cumulative ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setCumulative(true)}
              >
                Cumulative
              </button>
            </div>
          </div>
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
            ⚠ Pending transactions may take 1–3 days to fully reflect
          </p>
          <div className="flex flex-wrap gap-2 mb-4">
            <MultiSelectFilter
              label="All categories"
              options={allChartCategories}
              selected={filterCategories}
              onChange={setFilterCategories}
              className="w-[150px]"
            />
            <MultiSelectFilter
              label="All accounts"
              options={(accounts ?? []).map((a: any) => a.name).filter(Boolean)}
              selected={filterAccounts}
              onChange={setFilterAccounts}
              className="w-[150px]"
            />
          </div>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} />
                <YAxis tick={{ fontSize: 11 }} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(value: number) => [`$${value.toFixed(2)}`, ""]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {chartCategories.map((cat) => (
                  <Line
                    key={cat}
                    type="monotone"
                    dataKey={cat}
                    stroke={CATEGORY_COLORS[cat] ?? "#64748b"}
                    dot={false}
                    strokeWidth={2}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Bottom grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Transactions */}
        <Card className="border-none shadow-sm overflow-hidden lg:col-span-2">
          <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
            <h2 className="font-semibold tracking-tight">Recent Transactions</h2>
            <Link href="/transactions" className="text-xs text-primary hover:underline font-medium">View all →</Link>
          </div>
          {recentTxns.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              <Wallet className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p>No transactions yet.</p>
              <Link href="/accounts" className="text-primary hover:underline mt-2 inline-block font-medium">
                Link a bank account to get started
              </Link>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {recentTxns.map((txn) => (
                <TransactionRow key={txn.id} transaction={txn} showAccountInfo showCategoryBadge />
              ))}
            </div>
          )}
        </Card>

        {/* Quick Actions */}
        <div className="space-y-4">
          <Card className="border-none shadow-sm p-5">
            <h2 className="font-semibold tracking-tight mb-4">Quick Actions</h2>
            <div className="space-y-3">
              <Link href="/accounts">
                <div className="flex items-center gap-3 p-3 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer">
                  <Building2 className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Link Bank Account</span>
                </div>
              </Link>
              <Link href="/receipts">
                <div className="flex items-center gap-3 p-3 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer">
                  <Receipt className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Upload Receipt</span>
                </div>
              </Link>
              <Link href="/reconcile">
                <div className="flex items-center gap-3 p-3 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer">
                  <ArrowRightLeft className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">Run Reconciliation</span>
                </div>
              </Link>
              <Link href="/spending">
                <div className="flex items-center gap-3 p-3 rounded-md bg-secondary/30 hover:bg-secondary/50 transition-colors cursor-pointer">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  <span className="text-sm font-medium">View Cash Flow</span>
                </div>
              </Link>
            </div>
          </Card>

          {s.pendingReconciliation > 0 && (
            <Card className="border-none shadow-sm p-5 border-l-4 border-l-amber-500">
              <div className="flex items-start gap-3">
                <ArrowRightLeft className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">{s.pendingReconciliation} pending matches</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Receipts matched but not confirmed</p>
                  <Link href="/reconcile" className="text-xs text-primary hover:underline mt-1 inline-block">
                    Review now →
                  </Link>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function getMonthAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}
