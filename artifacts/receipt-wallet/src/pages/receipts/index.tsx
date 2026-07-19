import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { FileText, Plus, Search, Camera, Loader2, Check, X, Edit2 } from "lucide-react";
import { useListReceipts } from "@workspace/api-client-react";
import { API_BASE, authFetch } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface ExtractedItem {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  category: string | null;
}

interface ExtractionResult {
  status: string;
  engine: string;
  confidence: number;
  storeName: string | null;
  storeAddress: string | null;
  purchaseDate: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  paymentMethod: string | null;
  items: ExtractedItem[];
  error: string | null;
}

interface ScanResult {
  filePath: string;
  extraction: ExtractionResult;
}

function serializeReceipt(r: any) {
  return {
    id: r.id,
    storeName: r.storeName,
    storeAddress: r.storeAddress,
    purchaseDate: r.purchaseDate,
    total: r.total,
    processingStatus: r.processingStatus,
    ocrEngine: r.ocrEngine,
    ocrConfidence: r.ocrConfidence ?? null,
    sourceFilePath: r.sourceFilePath,
    matchId: r.matchId ?? null,
    createdAt: r.createdAt,
    returnWindowDays: r.returnWindowDays ?? null,
    returnDeadline: r.returnDeadline ?? null,
    notes: r.notes ?? null,
  };
}

export default function Receipts() {
  const [search, setSearch] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [showManual, setShowManual] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { data: receipts, isLoading } = useListReceipts(
    search ? { search } : undefined
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Step 1: Upload file for scanning
  const scanFile = async (file: File) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await authFetch(`${API_BASE}/api/receipts/scan`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Scan failed");
      }

      const result: ScanResult = await res.json();

      if (result.extraction.status === "manual_required" || result.extraction.status === "failed") {
        // OCR failed or unavailable — show manual entry
        setScanResult(result);
        setShowManual(true);
        toast({ title: "Auto-scan unavailable", description: "Please enter receipt details manually." });
      } else {
        // OCR succeeded — show verification
        setScanResult(result);
        setShowManual(false);
      }
    } catch (e: any) {
      toast({ title: "Scan failed", description: e.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) scanFile(file);
    e.target.value = "";
  };

  // Step 2: Confirm the extracted data
  const confirmReceipt = async (data: {
    storeName: string;
    purchaseDate: string;
    total: string;
    items: ExtractedItem[];
    returnWindowDays: string;
    notes: string;
  }) => {
    if (!scanResult) return;

    try {
      const res = await authFetch(`${API_BASE}/api/receipts/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filePath: scanResult.filePath,
          storeName: data.storeName || null,
          purchaseDate: data.purchaseDate || null,
          total: data.total ? parseFloat(data.total) : null,
          items: data.items,
          returnWindowDays: data.returnWindowDays ? parseInt(data.returnWindowDays) : null,
          notes: data.notes || null,
        }),
      });

      if (!res.ok) throw new Error("Failed to save receipt");

      const saved = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/receipts"] });

      // Reflect what actually happened with matching, since a receipt is
      // never auto-confirmed without the user looking at it — auto_matched
      // still needs confirmation on the receipt detail page (see
      // ReceiptDetail's Confirm/Not a match buttons), it's just already
      // linked to a candidate transaction.
      const matchStatus = saved?.match?.status;
      if (matchStatus === "auto_matched") {
        toast({ title: "Receipt saved", description: "Matched to a transaction — review to confirm." });
      } else if (matchStatus === "needs_review" && saved?.match?.suggestions?.length > 0) {
        toast({ title: "Receipt saved", description: "A few possible matches found — pick one on the receipt page." });
      } else {
        toast({ title: "Receipt saved", description: data.storeName || "Receipt confirmed" });
      }

      setScanResult(null);
      setShowManual(false);
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    }
  };

  const filtered = receipts ?? [];

  // ── Verification/Manual Entry Modal ──────────────────────────────────────
  if (scanResult) {
    return (
      <ReceiptVerification
        scanResult={scanResult}
        isManual={showManual}
        onConfirm={confirmReceipt}
        onCancel={() => { setScanResult(null); setShowManual(false); }}
      />
    );
  }

  // ── Main Receipt List ────────────────────────────────────────────────────
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Receipts</h1>
          <p className="text-muted-foreground mt-1 text-sm">Paper trail digitized and indexed.</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="shrink-0 shadow-sm"
            onClick={() => cameraInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Camera className="h-4 w-4 mr-2" />}
            Camera
          </Button>
          <Button
            className="shrink-0 shadow-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            data-testid="button-upload-receipt"
          >
            {isUploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
            Upload Receipt
          </Button>
        </div>

        {/* Hidden file inputs */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf"
          className="hidden"
          onChange={handleFileChange}
        />
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      <Card className="p-4 border-none shadow-sm">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search merchants, items, or totals..."
            className="pl-9 bg-secondary/30 border-transparent focus-visible:bg-background transition-colors"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </Card>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card className="border-dashed border-2 shadow-none bg-transparent">
          <div className="p-12 text-center flex flex-col items-center">
            <div className="h-12 w-12 rounded-full bg-secondary flex items-center justify-center mb-4">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground">No receipts found</h3>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              Upload your first receipt to start digitizing your paper trail and matching them to transactions.
            </p>
            <Button
              variant="outline"
              className="mt-6"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="h-4 w-4 mr-2" />
              Upload Receipt
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map((r: any) => (
            <Link key={r.id} href={`/receipts/${r.id}`}>
              <Card className="p-4 border-none shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-secondary/50 flex items-center justify-center">
                      <FileText className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-medium text-sm">{r.storeName || "Unknown Store"}</p>
                      <p className="text-xs text-muted-foreground">{r.purchaseDate || "No date"}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono font-medium text-sm">
                      {r.total != null ? `$${Number(r.total).toFixed(2)}` : "—"}
                    </p>
                    <p className="text-xs text-muted-foreground capitalize">{r.processingStatus}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}


// ── Receipt Verification Component ───────────────────────────────────────────

const DEFAULT_CATEGORIES = [
  "Groceries", "Dining", "Gas", "Shopping", "Health", "Entertainment",
  "Home", "Electronics", "Clothing", "Personal Care", "Other"
];

function ReceiptVerification({
  scanResult,
  isManual,
  onConfirm,
  onCancel,
}: {
  scanResult: ScanResult;
  isManual: boolean;
  onConfirm: (data: any) => void;
  onCancel: () => void;
}) {
  const ext = scanResult.extraction;
  const [storeName, setStoreName] = useState(ext.storeName || "");
  const [purchaseDate, setPurchaseDate] = useState(ext.purchaseDate || "");
  const [total, setTotal] = useState(ext.total?.toString() || "");
  const [returnWindowDays, setReturnWindowDays] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ExtractedItem[]>(
    ext.items?.length ? ext.items : []
  );
  const [saving, setSaving] = useState(false);

  const addItem = () => {
    setItems([...items, { description: "", quantity: 1, unitPrice: 0, lineTotal: 0, category: null }]);
  };

  const updateItem = (index: number, field: keyof ExtractedItem, value: any) => {
    const updated = [...items];
    (updated[index] as any)[field] = value;
    // Auto-calculate lineTotal
    if (field === "quantity" || field === "unitPrice") {
      updated[index].lineTotal = Number((updated[index].quantity * updated[index].unitPrice).toFixed(2));
    }
    setItems(updated);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  // Auto-sum total from items if items exist
  const itemsTotal = items.length > 0 ? items.reduce((sum, i) => sum + (i.lineTotal || 0), 0) : 0;

  const handleConfirm = async () => {
    setSaving(true);
    await onConfirm({
      storeName,
      purchaseDate,
      total: total || (itemsTotal > 0 ? itemsTotal.toFixed(2) : ""),
      items,
      returnWindowDays,
      notes,
    });
    setSaving(false);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {isManual ? "Manual Entry" : "Verify Receipt"}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {isManual
              ? "Enter the receipt details and items below."
              : `Extracted by Gemini (${Math.round(ext.confidence * 100)}% confidence). Review and edit as needed.`}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="h-4 w-4 mr-1" /> Cancel
        </Button>
      </div>

      {/* Receipt Header Info */}
      <Card className="p-6 border-none shadow-sm space-y-4">
        <h3 className="font-medium text-sm text-muted-foreground">Receipt Details</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Store Name</label>
            <Input value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder="e.g. Walmart" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Purchase Date</label>
            <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Total</label>
            <Input
              type="number"
              step="0.01"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              placeholder={itemsTotal > 0 ? `Auto: $${itemsTotal.toFixed(2)}` : "0.00"}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Return Window (days)</label>
            <Input type="number" value={returnWindowDays} onChange={(e) => setReturnWindowDays(e.target.value)} placeholder="30" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Notes</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
        </div>
      </Card>

      {/* Items Section */}
      <Card className="p-6 border-none shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-medium text-sm text-muted-foreground">
            Items ({items.length})
            {itemsTotal > 0 && <span className="ml-2 font-mono text-foreground">${itemsTotal.toFixed(2)}</span>}
          </h3>
          <Button variant="outline" size="sm" onClick={addItem}>
            <Plus className="h-3 w-3 mr-1" /> Add Item
          </Button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            <p>No items yet.</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={addItem}>
              <Plus className="h-3 w-3 mr-1" /> Add first item
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {items.map((item, i) => (
              <div key={i} className="flex flex-col sm:flex-row gap-2 p-3 rounded-md bg-secondary/30 relative group">
                {/* Description */}
                <div className="flex-1 space-y-1">
                  <Input
                    value={item.description}
                    onChange={(e) => updateItem(i, "description", e.target.value)}
                    placeholder="Item description"
                    className="text-sm h-8"
                  />
                </div>
                {/* Qty */}
                <div className="w-16 space-y-1">
                  <Input
                    type="number"
                    min="1"
                    value={item.quantity}
                    onChange={(e) => updateItem(i, "quantity", Number(e.target.value))}
                    className="text-sm h-8"
                    title="Qty"
                  />
                </div>
                {/* Unit Price */}
                <div className="w-24 space-y-1">
                  <Input
                    type="number"
                    step="0.01"
                    value={item.unitPrice || ""}
                    onChange={(e) => updateItem(i, "unitPrice", Number(e.target.value))}
                    placeholder="Price"
                    className="text-sm h-8"
                  />
                </div>
                {/* Category */}
                <div className="w-36 space-y-1">
                  <select
                    value={item.category || ""}
                    onChange={(e) => updateItem(i, "category", e.target.value || null)}
                    className="w-full h-8 px-2 rounded-md border bg-background text-xs text-foreground"
                  >
                    <option value="">Category...</option>
                    {DEFAULT_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
                {/* Line Total (read-only) */}
                <div className="w-20 flex items-center justify-end">
                  <span className="font-mono text-xs text-muted-foreground">
                    ${item.lineTotal.toFixed(2)}
                  </span>
                </div>
                {/* Remove */}
                <button
                  onClick={() => removeItem(i)}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10"
                  title="Remove item"
                >
                  <X className="h-3 w-3 text-destructive" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Actions */}
      <div className="flex gap-3 justify-end">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleConfirm} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Check className="h-4 w-4 mr-2" />}
          Confirm & Save
        </Button>
      </div>
    </div>
  );
}
