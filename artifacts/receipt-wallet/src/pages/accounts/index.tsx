import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Building2, Link as LinkIcon, Plus } from "lucide-react";

export default function Accounts() {
  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Accounts</h1>
          <p className="text-muted-foreground mt-1 text-sm">Manage your linked banking institutions.</p>
        </div>
        <Button className="shrink-0 shadow-sm">
          <LinkIcon className="h-4 w-4 mr-2" />
          Link Account
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <Card className="border-dashed border-2 shadow-none bg-transparent hover:bg-secondary/20 transition-colors cursor-pointer flex flex-col items-center justify-center p-8 min-h-[200px]">
          <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center mb-3">
            <Plus className="h-5 w-5 text-primary" />
          </div>
          <p className="font-medium text-foreground">Add New Account</p>
          <p className="text-xs text-muted-foreground mt-1">Connect via Plaid securely</p>
        </Card>
      </div>
    </div>
  );
}
