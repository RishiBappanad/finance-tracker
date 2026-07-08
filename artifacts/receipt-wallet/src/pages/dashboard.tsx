import { useState, useEffect } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt, Wallet, AlertCircle, ArrowRightLeft, TrendingUp, Building2 } from "lucide-react";
import { Link } from "wouter";
import { TransactionRow, type TransactionData } from "@/components/transaction-row";
import { API_BASE } from "@/lib/api";
import { useListAccounts } from "@workspace/api-client-react";

interface DashboardSummary {
  totalReceipts: number;
  matchedReceipts: number;
  unmatchedReceipts: number;
  totalTransactions: number;
  unmatchedTransactions: number;
  expiringReturns: number;
  totalSpendThisMonth: number;
  pendingReconciliation: number;
}

function formatCurrency(amount: number | null | undefined) {
  if (amount == null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

export default function Dashboard() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [recentTxns, setRecentTxns] = useState<TransactionData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { data: accounts } = useListAccounts();

  useEffect(() => {
    async function fetchDashboard() {
      try {
        const [summaryRes, txnRes] = await Promise.all([
          fetch(`${API_BASE}/api/dashboard/summary`),
          fetch(`${API_BASE}/api/transactions?from=` + getMonthAgo()),
        ]);
        const summaryData = await summaryRes.json();
        const txnData: TransactionData[] = await txnRes.json();

        setSummary(summaryData);
        // Show most recent 8 transactions
        setRecentTxns(txnData.slice(-8).reverse());
      } catch {
        // graceful fail
      } finally {
        setIsLoading(false);
      }
    }
    fetchDashboard();
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  const s = summary ?? {
    totalReceipts: 0,
    matchedReceipts: 0,
    unmatchedReceipts: 0,
    totalTransactions: 0,
    unmatchedTransactions: 0,
    expiringReturns: 0,
    totalSpendThisMonth: 0,
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

      {/* Recent Transactions + Quick Actions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Recent Transactions (2/3 width) */}
        <Card className="border-none shadow-sm overflow-hidden lg:col-span-2">
          <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
            <h2 className="font-semibold tracking-tight">Recent Transactions</h2>
            <Link href="/transactions" className="text-xs text-primary hover:underline font-medium">
              View all →
            </Link>
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
                <TransactionRow
                  key={txn.id}
                  transaction={txn}
                  showAccountInfo
                  showCategoryBadge
                />
              ))}
            </div>
          )}
        </Card>

        {/* Quick Actions (1/3 width) */}
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
                  <span className="text-sm font-medium">View Spending</span>
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
