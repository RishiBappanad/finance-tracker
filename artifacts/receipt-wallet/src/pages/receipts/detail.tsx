import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar, ArrowLeft, CheckCircle2, Store, Loader2, X, Check } from "lucide-react";
import { Link, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import {
  useGetReceipt,
  useUpdateReceiptItem,
  useListReceiptCategories,
  useGetReceiptSuggestions,
  getGetReceiptSuggestionsQueryKey,
  useUpdateMatch,
  useCreateMatch,
  useDeleteMatch,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function ReceiptDetail() {
  const { id } = useParams();
  const receiptId = Number(id);
  const { data: receipt, isLoading } = useGetReceipt(receiptId);
  const { data: categories } = useListReceiptCategories();
  const { mutateAsync: updateItem } = useUpdateReceiptItem();
  const { mutateAsync: updateMatch, isPending: isConfirming } = useUpdateMatch();
  const { mutateAsync: deleteMatch, isPending: isRejecting } = useDeleteMatch();
  const { mutateAsync: createMatch, isPending: isAccepting } = useCreateMatch();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Only fetch suggestions once we know the receipt has no match yet —
  // avoids an extra matcher run on every load for receipts that are
  // already matched (confirmed or not).
  const needsSuggestions = !!receipt && !receipt.match;
  const { data: suggestionData, isLoading: loadingSuggestions } = useGetReceiptSuggestions(receiptId, {
    query: { enabled: needsSuggestions, queryKey: getGetReceiptSuggestionsQueryKey(receiptId) },
  });

  const invalidateReceipt = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/receipts", receiptId] });
    queryClient.invalidateQueries({ queryKey: ["/api/receipts"] });
  };

  const handleCategoryChange = async (itemId: number, category: string) => {
    try {
      await updateItem({ receiptId, itemId, data: { category } });
      invalidateReceipt();
    } catch {
      toast({ title: "Update failed", description: "Could not update item category.", variant: "destructive" });
    }
  };

  // Confirmation is required before an auto-match is treated as final —
  // reconcileOneReceipt() creates matches with confirmed=false, exactly
  // like the existing manual-review flow on the Reconcile page. This is
  // the same confirmed/PATCH mechanism, just surfaced here too, so an
  // auto-match right after Gemini parses a receipt is never silently
  // trusted without the user looking at it.
  const handleConfirmMatch = async () => {
    if (!receipt?.match) return;
    try {
      await updateMatch({ matchId: receipt.match.matchId, data: { confirmed: true } });
      invalidateReceipt();
      toast({ title: "Match confirmed" });
    } catch {
      toast({ title: "Could not confirm match", variant: "destructive" });
    }
  };

  const handleRejectMatch = async () => {
    if (!receipt?.match) return;
    try {
      await deleteMatch({ matchId: receipt.match.matchId });
      invalidateReceipt();
      toast({ title: "Match removed", description: "This receipt is unmatched again." });
    } catch {
      toast({ title: "Could not remove match", variant: "destructive" });
    }
  };

  const handleAcceptSuggestion = async (bankTransactionId: string) => {
    try {
      await createMatch({ data: { receiptId, bankTransactionId } });
      invalidateReceipt();
      queryClient.invalidateQueries({ queryKey: getGetReceiptSuggestionsQueryKey(receiptId) });
      toast({ title: "Matched", description: "Receipt linked to transaction." });
    } catch {
      toast({ title: "Could not link transaction", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!receipt) {
    return (
      <div className="p-12 text-center">
        <p className="text-muted-foreground">Receipt not found.</p>
        <Button variant="outline" className="mt-4" asChild>
          <Link href="/receipts">Back to Receipts</Link>
        </Button>
      </div>
    );
  }

  const items = receipt.items ?? [];
  const itemsSubtotal = items.reduce((sum, i) => sum + (i.lineTotal ?? 0), 0);
  const suggestions = suggestionData?.suggestions ?? [];

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
          <h1 className="text-3xl font-bold tracking-tight text-foreground">
            {receipt.storeName || `Receipt #${receipt.id}`}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm flex items-center gap-2">
            <Calendar className="h-4 w-4" /> {receipt.purchaseDate || "No date recorded"}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-none shadow-sm p-6">
            <h3 className="font-semibold mb-4 text-lg">Line Items</h3>
            {items.length === 0 ? (
              <div className="p-8 text-center border-dashed border-2 rounded-md bg-transparent">
                <p className="text-muted-foreground text-sm">No items extracted.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col sm:flex-row sm:items-center gap-2 p-3 rounded-md bg-secondary/30"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.quantity} × ${item.unitPrice.toFixed(2)}
                      </p>
                    </div>
                    <div className="w-40">
                      <Select
                        value={item.category || ""}
                        onValueChange={(value) => handleCategoryChange(item.id, value)}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Uncategorized" />
                        </SelectTrigger>
                        <SelectContent>
                          {(categories ?? []).map((cat) => (
                            <SelectItem key={cat} value={cat} className="text-xs">
                              {cat}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <span className="font-mono text-sm text-right w-20 shrink-0">
                      ${item.lineTotal.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-none shadow-sm p-6 bg-secondary/10">
            <h3 className="font-semibold mb-4 text-lg">Summary</h3>
            <div className="space-y-3 font-mono text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span>${(receipt.subtotal ?? itemsSubtotal).toFixed(2)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tax</span>
                <span>${(receipt.tax ?? 0).toFixed(2)}</span>
              </div>
              <div className="flex justify-between font-bold text-base pt-3 border-t border-border/50">
                <span>Total</span>
                <span>${(receipt.total ?? 0).toFixed(2)}</span>
              </div>
            </div>
          </Card>

          <Card className="border-none shadow-sm p-6">
            <h3 className="font-semibold mb-4 text-lg">Reconciliation</h3>
            {receipt.match ? (
              <div className="space-y-3">
                <div className={`flex items-center gap-2 text-sm ${receipt.match.confirmed ? "text-green-600" : "text-amber-600"}`}>
                  <CheckCircle2 className="h-4 w-4" />
                  <span className="font-medium">
                    {receipt.match.confirmed ? "Matched & confirmed" : "Matched — needs your confirmation"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 rounded-md bg-secondary/30">
                  <Store className="h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate text-foreground">
                      {receipt.match.transaction.merchantName || "Unknown merchant"}
                    </p>
                    <p className="text-xs">
                      {receipt.match.transaction.date} • ${Math.abs(receipt.match.transaction.amount).toFixed(2)}
                    </p>
                  </div>
                </div>
                {!receipt.match.confirmed && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={handleConfirmMatch}
                      disabled={isConfirming || isRejecting}
                    >
                      <Check className="h-3.5 w-3.5 mr-1.5" /> Confirm
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={handleRejectMatch}
                      disabled={isConfirming || isRejecting}
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" /> Not a match
                    </Button>
                  </div>
                )}
              </div>
            ) : loadingSuggestions ? (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : suggestions.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  No auto-match yet — here's what looks close. Pick one to link it.
                </p>
                {suggestions.map((s) => (
                  <div
                    key={s.bankTransactionId}
                    className="flex items-center justify-between gap-2 p-3 rounded-md bg-secondary/30"
                  >
                    <div className="min-w-0">
                      <p className="text-sm truncate text-foreground">{s.merchantName || "Unknown merchant"}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.date} • ${Math.abs(s.amount).toFixed(2)} • {Math.round(s.confidenceScore * 100)}% match
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => handleAcceptSuggestion(s.bankTransactionId)}
                      disabled={isAccepting}
                    >
                      Link
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-4">
                <p className="text-muted-foreground text-sm mb-3">Not yet matched to a transaction.</p>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/reconcile">Go to Reconciliation</Link>
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
