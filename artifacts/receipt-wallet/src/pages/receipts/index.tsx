import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Link } from "wouter";
import { FileText, Plus, Search, Camera, Upload, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useListReceipts } from "@workspace/api-client-react";
import { API_BASE } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Receipts() {
  const [search, setSearch] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const { data: receipts, isLoading } = useListReceipts(
    search ? { search } : undefined
  );
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadFile = async (file: File) => {
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch(`${API_BASE}/api/receipts/upload`, {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Upload failed");
      }

      queryClient.invalidateQueries({ queryKey: ["/api/receipts"] });
      toast({ title: "Receipt uploaded", description: file.name });
    } catch (e: any) {
      toast({ title: "Upload failed", description: e.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = "";
  };

  const filtered = receipts ?? [];

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
            <Camera className="h-4 w-4 mr-2" />
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
              <Upload className="h-4 w-4 mr-2" />
              Upload PDF or Image
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filtered.map((receipt) => (
            <Link key={receipt.id} href={`/receipts/${receipt.id}`}>
              <Card className="p-4 shadow-sm hover:bg-secondary/20 transition-colors cursor-pointer">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center shrink-0">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {receipt.storeName || "Unknown Store"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {receipt.purchaseDate || "No date"} • {receipt.processingStatus}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {receipt.total != null && (
                      <span className="text-sm font-mono font-medium">${receipt.total.toFixed(2)}</span>
                    )}
                    {receipt.matchId && (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Matched</span>
                    )}
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
