import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Wallet, Sparkles, AlertCircle, Loader2, FileText } from "lucide-react";
import { TransactionRow } from "@/components/transaction-row";
import {
  useListUnmatchedReceipts,
  useListUnmatchedTransactions,
  runReconciliation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Reconcile() {
  const [isRunning, setIsRunning] = useState(false);
  const { data: unmatchedReceipts, isLoading: loadingReceipts } = useListUnmatchedReceipts();
  const { data: unmatchedTxns, isLoading: loadingTxns } = useListUnmatchedTransactions();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleAutoMatch = async () => {
    setIsRunning(true);
    try {
      const result = await runReconciliation();
      queryClient.invalidateQueries({ queryKey: ["/api/receipts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconcile"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      toast({
        title: "Reconciliation complete",
        description: `Auto-matched: ${result.autoMatched}, Needs review: ${result.needsReview}, Unmatched: ${result.unmatched}`,
      });
    } catch {
      toast({ title: "Reconciliation failed", description: "Could not run auto-match.", variant: "destructive" });
    } finally {
      setIsRunning(false);
    }
  };

  const isLoading = loadingReceipts || loadingTxns;
  const receipts = unmatchedReceipts ?? [];
  const transactions = unmatchedTxns ?? [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Reconciliation</h1>
          <p className="text-muted-foreground mt-1 text-sm">Bridge the gap between paper and bank data.</p>
        </div>
        <Button
          className="shrink-0 shadow-sm"
          onClick={handleAutoMatch}
          disabled={isRunning}
          data-testid="button-auto-match"
        >
          {isRunning ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Sparkles className="h-4 w-4 mr-2" />}
          Run Auto-Match
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 min-h-0">
          {/* Left Side: Unmatched Receipts */}
          <Card className="border-none shadow-sm flex flex-col overflow-hidden bg-card">
            <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
              <h2 className="font-semibold tracking-tight">Unmatched Receipts</h2>
              <span className="text-xs font-mono bg-secondary px-2 py-1 rounded-full">{receipts.length} items</span>
            </div>
            {receipts.length === 0 ? (
              <div className="flex-1 p-8 text-center flex flex-col items-center justify-center">
                <Wallet className="h-8 w-8 text-muted-foreground mb-4 opacity-50" />
                <p className="text-muted-foreground text-sm">All receipts have been matched.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto divide-y divide-border">
                {receipts.map((receipt) => (
                  <div key={receipt.id} className="p-3 flex items-center justify-between hover:bg-secondary/10">
                    <div className="flex items-center gap-2 min-w-0">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{receipt.storeName || "Unknown"}</p>
                        <p className="text-xs text-muted-foreground">{receipt.purchaseDate || "No date"}</p>
                      </div>
                    </div>
                    {receipt.total != null && (
                      <span className="text-sm font-mono shrink-0">${receipt.total.toFixed(2)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Right Side: Unmatched Transactions */}
          <Card className="border-none shadow-sm flex flex-col overflow-hidden bg-card">
            <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
              <h2 className="font-semibold tracking-tight">Unmatched Transactions</h2>
              <span className="text-xs font-mono bg-secondary px-2 py-1 rounded-full">{transactions.length} items</span>
            </div>
            {transactions.length === 0 ? (
              <div className="flex-1 p-8 text-center flex flex-col items-center justify-center">
                <AlertCircle className="h-8 w-8 text-muted-foreground mb-4 opacity-50" />
                <p className="text-muted-foreground text-sm">No pending transactions to match.</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto divide-y divide-border">
                {transactions.map((txn: any) => (
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
        </div>
      )}
    </div>
  );
}
