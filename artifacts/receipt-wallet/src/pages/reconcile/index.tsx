import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Wallet, Sparkles, AlertCircle } from "lucide-react";

export default function Reconcile() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 flex flex-col h-[calc(100vh-8rem)]">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Reconciliation</h1>
          <p className="text-muted-foreground mt-1 text-sm">Bridge the gap between paper and bank data.</p>
        </div>
        <Button className="shrink-0 shadow-sm" data-testid="button-auto-match">
          <Sparkles className="h-4 w-4 mr-2" />
          Run Auto-Match
        </Button>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 min-h-0">
        {/* Left Side: Unmatched Receipts */}
        <Card className="border-none shadow-sm flex flex-col overflow-hidden bg-card">
          <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
            <h2 className="font-semibold tracking-tight">Unmatched Receipts</h2>
            <span className="text-xs font-mono bg-secondary px-2 py-1 rounded-full">0 items</span>
          </div>
          <div className="flex-1 p-8 text-center flex flex-col items-center justify-center">
            <Wallet className="h-8 w-8 text-muted-foreground mb-4 opacity-50" />
            <p className="text-muted-foreground text-sm">All receipts have been matched.</p>
          </div>
        </Card>

        {/* Right Side: Unmatched Transactions */}
        <Card className="border-none shadow-sm flex flex-col overflow-hidden bg-card">
          <div className="p-4 border-b border-border bg-secondary/10 flex justify-between items-center">
            <h2 className="font-semibold tracking-tight">Unmatched Transactions</h2>
            <span className="text-xs font-mono bg-secondary px-2 py-1 rounded-full">0 items</span>
          </div>
          <div className="flex-1 p-8 text-center flex flex-col items-center justify-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground mb-4 opacity-50" />
            <p className="text-muted-foreground text-sm">No pending transactions to match.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
