import { useState, useEffect, useCallback } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Receipt, Wallet, AlertCircle, ArrowRightLeft, TrendingUp, Building2,
  ChevronLeft, ChevronRight, Target, CheckCircle2, Loader2,
} from "lucide-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { TransactionRow, type TransactionData } from "@/components/transaction-row";
import { MultiSelectFilter } from "@/components/multi-select-filter";
import { useListAccounts, useListUserCategories } from "@workspace/api-client-react";
import { API_BASE, authFetch } from "@/lib/api";
import { resolveCategoryColor } from "@/lib/category-colors";
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

interface GoalSummary {
  id: number;
  label: string | null;
  term: "everyday" | "long_term";
}

function formatCurrency(amount: number | null | undefined) {
  if (amount == null) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(d: Date): Date {
  const start = new Date(d);
  start.setDate(start.getDate() - start.getDay()); // back up to Sunday
  return start;
}

function formatDayLabel(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function formatWeekLabel(d: Date): string {
  const start = startOfWeek(d);
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startLabel = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
  const endLabel = sameMonth ? `${end.getDate()}` : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
  return `${startLabel}–${endLabel}, ${end.getFullYear()}`;
}

export default function Dashboard() {
  const { data: userCategories } = useListUserCategories();
  const categoryColorOverrides = Object.fromEntries(
    (userCategories ?? []).filter((c) => c.color).map((c) => [c.name, c.color as string])
  );
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [chartCategories, setChartCategories] = useState<string[]>([]);
  const [cumulative, setCumulative] = useState(false);
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterAccounts, setFilterAccounts] = useState<string[]>([]);
  const [allChartCategories, setAllChartCategories] = useState<string[]>([]);
  const [chartFrom, setChartFrom] = useState(getMonthAgo());
  const [chartTo, setChartTo] = useState(new Date().toISOString().slice(0, 10));
  const [isLoading, setIsLoading] = useState(true);
  const { data: accounts } = useListAccounts();

  // Recent Transactions' daily/weekly, calendar-style view -- txnAnchor is
  // "the day currently in view" either way; weekly mode widens it out to
  // that day's whole (Sunday-Saturday) week. Defaults to the current week
  // rather than today alone, since a brand-new day is often still empty
  // (Plaid transactions can take 1-3 days to settle, see the chart's own
  // warning below) and an empty "Today" would be a bad first impression.
  const [txnViewMode, setTxnViewMode] = useState<"daily" | "weekly">("weekly");
  const [txnAnchor, setTxnAnchor] = useState(new Date());
  const [txnList, setTxnList] = useState<TransactionData[]>([]);
  const [txnLoading, setTxnLoading] = useState(true);

  const [goals, setGoals] = useState<GoalSummary[] | null>(null);
  const [goalStatuses, setGoalStatuses] = useState<Record<number, { on_track: boolean }>>({});

  useEffect(() => {
    async function fetchDashboard() {
      try {
        const res = await authFetch(`${API_BASE}/api/dashboard/summary`);
        setSummary(await res.json());
      } catch {}
      finally { setIsLoading(false); }
    }
    fetchDashboard();
  }, []);

  useEffect(() => {
    fetchChartData();
  }, [cumulative, filterCategories, filterAccounts, chartFrom, chartTo]);

  const txnRange = txnViewMode === "daily"
    ? { from: toISODate(txnAnchor), to: toISODate(txnAnchor) }
    : { from: toISODate(startOfWeek(txnAnchor)), to: toISODate(addDays(startOfWeek(txnAnchor), 6)) };

  const fetchTxnRange = useCallback(async (from: string, to: string) => {
    setTxnLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/api/transactions?from=${from}&to=${to}`);
      const data: TransactionData[] = await res.json();
      data.sort((a, b) => b.date.localeCompare(a.date));
      setTxnList(data);
    } catch {
      setTxnList([]);
    } finally {
      setTxnLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTxnRange(txnRange.from, txnRange.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txnViewMode, txnRange.from, txnRange.to]);

  useEffect(() => {
    async function fetchGoalsOverview() {
      try {
        const res = await authFetch(`${API_BASE}/api/goals?active=true`);
        const list: GoalSummary[] = await res.json();
        setGoals(list);
        const entries = await Promise.all(
          list.slice(0, 6).map(async (g) => {
            const r = await authFetch(`${API_BASE}/api/goals/${g.id}/status`);
            return [g.id, await r.json()] as const;
          })
        );
        setGoalStatuses(Object.fromEntries(entries));
      } catch {
        setGoals([]);
      }
    }
    fetchGoalsOverview();
  }, []);

  async function fetchChartData() {
    try {
      const params = new URLSearchParams({
        from: chartFrom,
        to: chartTo,
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
            <Link href="/spending" className="text-xs text-primary hover:underline mt-2 inline-block font-medium">
              View Cash Flow →
            </Link>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Linked Accounts</CardTitle>
            <Building2 className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">{accounts?.length ?? 0}</div>
            <Link href="/accounts" className="text-xs text-primary hover:underline mt-2 inline-block font-medium">
              Link Bank Account →
            </Link>
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
            <Link href="/receipts" className="text-xs text-primary hover:underline mt-2 inline-block font-medium">
              Upload Receipt →
            </Link>
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
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="font-semibold tracking-tight">Spending Over Time</h2>
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
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <Input
              type="date"
              value={chartFrom}
              onChange={(e) => setChartFrom(e.target.value)}
              className="w-auto h-8 text-xs bg-secondary/30 border-transparent"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              value={chartTo}
              onChange={(e) => setChartTo(e.target.value)}
              className="w-auto h-8 text-xs bg-secondary/30 border-transparent"
            />
            <div className="flex gap-1">
              {[
                { label: "1W", days: 7 },
                { label: "1M", days: 30 },
                { label: "3M", days: 90 },
                { label: "6M", days: 180 },
                { label: "1Y", days: 365 },
              ].map(({ label, days }) => (
                <button
                  key={label}
                  className="px-2 py-1 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
                  onClick={() => {
                    const to = new Date();
                    const from = new Date();
                    from.setDate(from.getDate() - days);
                    setChartFrom(from.toISOString().slice(0, 10));
                    setChartTo(to.toISOString().slice(0, 10));
                  }}
                >
                  {label}
                </button>
              ))}
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
                    stroke={resolveCategoryColor(cat, categoryColorOverrides)}
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

      {/* Recent Transactions -- expanded, calendar-style daily/weekly view.
          Full width now that Quick Actions' 4 links moved onto their
          corresponding stat cards above; Run Reconciliation (no natural
          stat-card home of its own) lives in this card's header instead. */}
      <Card className="border-none shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border bg-secondary/10 flex flex-wrap justify-between items-center gap-3">
          <h2 className="font-semibold tracking-tight">Recent Transactions</h2>
          <div className="flex items-center gap-3">
            {s.pendingReconciliation > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">
                {s.pendingReconciliation} pending match{s.pendingReconciliation === 1 ? "" : "es"}
              </span>
            )}
            <Link href="/reconcile">
              <div className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline cursor-pointer">
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Run Reconciliation
              </div>
            </Link>
            <Link href="/transactions" className="text-xs text-primary hover:underline font-medium">View all →</Link>
          </div>
        </div>

        {/* Calendar-style controls: Daily/Weekly mode, then step by day or
            week, same button-group idiom as the chart's Daily/Cumulative
            toggle above for visual consistency. */}
        <div className="p-4 border-b border-border flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-secondary/40 rounded-lg">
            <button
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${txnViewMode === "daily" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTxnViewMode("daily")}
            >
              Daily
            </button>
            <button
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${txnViewMode === "weekly" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => setTxnViewMode("weekly")}
            >
              Weekly
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setTxnAnchor((d) => addDays(d, txnViewMode === "daily" ? -1 : -7))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs font-medium min-w-[170px] text-center">
              {txnViewMode === "daily" ? formatDayLabel(txnAnchor) : formatWeekLabel(txnAnchor)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setTxnAnchor((d) => addDays(d, txnViewMode === "daily" ? 1 : 7))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setTxnAnchor(new Date())}>
              Today
            </Button>
          </div>
        </div>

        {txnLoading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : txnList.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            <Wallet className="h-8 w-8 mx-auto mb-3 opacity-50" />
            <p>No transactions {txnViewMode === "daily" ? "on this day" : "this week"}.</p>
            <Link href="/accounts" className="text-primary hover:underline mt-2 inline-block font-medium">
              Link a bank account to get started
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {txnList.map((txn) => (
              <TransactionRow key={txn.id} transaction={txn} showAccountInfo showCategoryBadge />
            ))}
          </div>
        )}
      </Card>

      {/* Goals Overview -- lightweight summary, click through to Goals for
          the full picture (creating one, target dates, crossing history). */}
      <Link href="/goals">
        <Card className="border-none shadow-sm p-5 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Target className="h-4 w-4 text-primary" />
              <h2 className="font-semibold tracking-tight">Goals Overview</h2>
            </div>
            <span className="text-xs text-primary hover:underline font-medium">View all →</span>
          </div>
          {goals === null ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : goals.length === 0 ? (
            <p className="text-sm text-muted-foreground">No goals yet. Set a spending cap or a savings target.</p>
          ) : (
            <div className="space-y-2">
              {goals.slice(0, 6).map((g) => {
                const status = goalStatuses[g.id];
                return (
                  <div key={g.id} className="flex items-center justify-between text-sm">
                    <span className="truncate">{g.label || `Goal #${g.id}`}</span>
                    {status ? (
                      status.on_track ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-600 shrink-0">
                          <CheckCircle2 className="h-3.5 w-3.5" /> On track
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-xs text-destructive shrink-0">
                          <AlertCircle className="h-3.5 w-3.5" /> Off track
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-muted-foreground shrink-0">…</span>
                    )}
                  </div>
                );
              })}
              {goals.length > 6 && (
                <p className="text-xs text-muted-foreground pt-1">+{goals.length - 6} more</p>
              )}
            </div>
          )}
        </Card>
      </Link>
    </div>
  );
}

function getMonthAgo(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 10);
}
