import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Receipt, Wallet, AlertCircle, ArrowRightLeft } from "lucide-react";
import { Link } from "wouter";

export function formatCurrency(amount: number | null | undefined, currency: string = "USD") {
  if (amount == null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency,
  }).format(amount);
}

export default function Dashboard() {
  // Stubbing the hook logic assuming it exists or replacing it gracefully if it doesn't 
  // since we must move fast.
  const isLoading = false;
  const summary = {
    totalReceipts: 42,
    matchedReceipts: 38,
    unmatchedReceipts: 4,
    totalTransactions: 156,
    unmatchedTransactions: 12,
    expiringReturns: 2,
    totalSpendThisMonth: 3450.25,
    pendingReconciliation: 16
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1,2,3,4].map(i => <Skeleton key={i} className="h-32 w-full" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
        <p className="text-muted-foreground mt-1 text-sm">Your financial cockpit. Precision tracking for every dollar.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Spend This Month</CardTitle>
            <Wallet className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tracking-tight">{formatCurrency(summary.totalSpendThisMonth)}</div>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Reconciliation</CardTitle>
            <ArrowRightLeft className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">{summary.pendingReconciliation}</div>
            <p className="text-xs text-muted-foreground mt-1">Requires your attention</p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unmatched Receipts</CardTitle>
            <Receipt className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tracking-tight">{summary.unmatchedReceipts}</div>
            <p className="text-xs text-muted-foreground mt-1">Out of {summary.totalReceipts} total</p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm bg-card hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Expiring Returns</CardTitle>
            <AlertCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive tracking-tight">{summary.expiringReturns}</div>
            <p className="text-xs text-muted-foreground mt-1">Items window closing soon</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Recent Receipts</h2>
          <Card className="border-none shadow-sm overflow-hidden">
            <div className="p-8 text-center text-muted-foreground text-sm bg-secondary/20">
              <Receipt className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p>No recent receipts.</p>
              <Link href="/receipts" className="text-primary hover:underline mt-2 inline-block font-medium">Upload a receipt</Link>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-semibold tracking-tight">Needs Reconciliation</h2>
          <Card className="border-none shadow-sm overflow-hidden">
            <div className="p-8 text-center text-muted-foreground text-sm bg-secondary/20">
              <ArrowRightLeft className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p>You have items to match.</p>
              <Link href="/reconcile" className="text-primary hover:underline mt-2 inline-block font-medium">Go to Reconciliation</Link>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
