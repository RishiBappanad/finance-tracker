import { Card } from "@/components/ui/card";
import { Receipt, Calendar, ArrowLeft } from "lucide-react";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";

export default function ReceiptDetail() {
  const { id } = useParams();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Button variant="ghost" size="sm" className="mb-2 -ml-3 text-muted-foreground hover:text-foreground" asChild>
        <Link href="/receipts">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Receipts
        </Link>
      </Button>
      
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Receipt #{id}</h1>
          <p className="text-muted-foreground mt-1 text-sm flex items-center gap-2">
            <Calendar className="h-4 w-4" /> Scanned recently
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-none shadow-sm p-6">
            <h3 className="font-semibold mb-4 text-lg">Line Items</h3>
            <div className="p-8 text-center border-dashed border-2 rounded-md bg-transparent">
              <p className="text-muted-foreground text-sm">No items extracted.</p>
            </div>
          </Card>
        </div>
        
        <div className="space-y-6">
          <Card className="border-none shadow-sm p-6 bg-secondary/10">
            <h3 className="font-semibold mb-4 text-lg">Summary</h3>
            <div className="space-y-3 font-mono text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>$0.00</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>$0.00</span>
              </div>
              <div className="flex justify-between font-bold text-base pt-3 border-t border-border/50">
                <span>Total</span>
                <span>$0.00</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
