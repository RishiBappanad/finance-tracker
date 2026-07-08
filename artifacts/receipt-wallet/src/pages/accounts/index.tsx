import { useState, useCallback, useEffect } from "react";
import { usePlaidLink } from "react-plaid-link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Building2, Link as LinkIcon, Plus, Loader2, Trash2 } from "lucide-react";
import { useListAccounts, createAccount, deleteAccount } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Accounts() {
  const { data: accounts, isLoading } = useListAccounts();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);

  // Fetch a link token from the server
  const fetchLinkToken = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:5001/api/accounts/create-link-token", {
        method: "POST",
      });
      const data = await res.json();
      if (data.linkToken) {
        setLinkToken(data.linkToken);
      } else {
        toast({ title: "Error", description: data.error || "Failed to create link token", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Error", description: "Could not connect to server", variant: "destructive" });
    }
  }, [toast]);

  const onSuccess = useCallback(
    async (publicToken: string, metadata: any) => {
      setIsLinking(true);
      try {
        await createAccount({
          publicToken,
          institutionId: metadata.institution?.institution_id ?? "unknown",
          institutionName: metadata.institution?.name ?? "Unknown Bank",
        });
        queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
        toast({ title: "Account linked!", description: `Connected ${metadata.institution?.name ?? "bank account"} successfully.` });
      } catch (e) {
        toast({ title: "Error", description: "Failed to link account", variant: "destructive" });
      } finally {
        setIsLinking(false);
        setLinkToken(null);
      }
    },
    [queryClient, toast]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  // Auto-open Plaid Link when token is ready
  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const handleLinkClick = () => {
    fetchLinkToken();
  };

  const handleDelete = async (accountId: string) => {
    try {
      await deleteAccount(accountId);
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      toast({ title: "Account removed" });
    } catch {
      toast({ title: "Error", description: "Failed to remove account", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage your linked banking institutions.</p>
        </div>
        <Button className="shrink-0 shadow-sm" onClick={handleLinkClick} disabled={isLinking}>
          {isLinking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LinkIcon className="h-4 w-4 mr-2" />}
          Link Account
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accounts?.map((account) => (
            <Card key={account.id} className="p-6 shadow-sm relative group">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Building2 className="h-5 w-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{account.name}</p>
                  <p className="text-xs text-muted-foreground">{account.institutionName ?? "Unknown Institution"}</p>
                  <div className="flex gap-2 mt-2">
                    <span className="text-xs bg-secondary px-2 py-0.5 rounded-full capitalize">{account.type}</span>
                    {account.mask && (
                      <span className="text-xs text-muted-foreground">••••{account.mask}</span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="opacity-0 group-hover:opacity-100 transition-opacity h-8 w-8"
                  onClick={() => handleDelete(account.id)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </Card>
          ))}

          <Card
            className="border-dashed border-2 shadow-none bg-transparent hover:bg-secondary/20 transition-colors cursor-pointer flex flex-col items-center justify-center p-8 min-h-[200px]"
            onClick={handleLinkClick}
          >
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
              <Plus className="h-5 w-5 text-primary" />
            </div>
            <p className="font-medium text-foreground">Add New Account</p>
            <p className="text-xs text-muted-foreground mt-1">Connect via Plaid securely</p>
          </Card>
        </div>
      )}
    </div>
  );
}
