import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "wouter";
import { FileText, Plus, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export default function Receipts() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Receipts</h1>
          <p className="text-muted-foreground mt-1 text-sm">Paper trail digitized and indexed.</p>
        </div>
        <Button className="shrink-0 shadow-sm" data-testid="button-upload-receipt">
          <Plus className="h-4 w-4 mr-2" />
          Upload Receipt
        </Button>
      </div>

      <Card className="p-4 border-none shadow-sm">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input 
            placeholder="Search merchants, items, or totals..." 
            className="pl-9 bg-secondary/30 border-transparent focus-visible:bg-background transition-colors"
          />
        </div>
      </Card>

      <div className="grid gap-4">
        {/* Placeholder empty state */}
        <Card className="border-dashed border-2 shadow-none bg-transparent">
          <div className="p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">No receipts found</h3>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              Upload your first receipt to start digitizing your paper trail and matching them to transactions.
            </p>
            <Button variant="outline" className="mt-6">
              Upload PDF or Image
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
