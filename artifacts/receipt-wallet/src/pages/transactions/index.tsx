import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeftRight, RefreshCw, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Transactions() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Transactions</h1>
          <p className="text-muted-foreground mt-1 text-sm">Every bank transaction, ready to be justified.</p>
        </div>
        <Button variant="outline" className="shrink-0 shadow-sm bg-card hover:bg-secondary">
          <RefreshCw className="h-4 w-4 mr-2" />
          Sync Latest
        </Button>
      </div>

      <Card className="p-4 border-none shadow-sm flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search merchants or amounts..." 
            className="pl-9 bg-secondary/30 border-transparent focus-visible:bg-background transition-colors"
          />
        </div>
      </Card>

      <Card className="border-dashed border-2 shadow-none bg-transparent">
        <div className="p-12 text-center flex flex-col items-center">
          <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
            <ArrowLeftRight className="h-6 w-6 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-medium text-foreground">No transactions synced</h3>
          <p className="text-muted-foreground text-sm mt-1 max-w-sm">
            Connect a bank account to automatically import and categorize your transactions.
          </p>
        </div>
      </Card>
    </div>
  );
}
