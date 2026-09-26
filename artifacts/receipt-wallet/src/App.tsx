import { useEffect } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { redirectToLogin } from "trackstack-ui";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import Dashboard from "@/pages/dashboard";
import Receipts from "@/pages/receipts/index";
import ReceiptDetail from "@/pages/receipts/detail";
import Transactions from "@/pages/transactions/index";
import Reconcile from "@/pages/reconcile/index";
import Spending from "@/pages/spending/index";
import Goals from "@/pages/goals/index";
import Recurring from "@/pages/recurring/index";
import Accounts from "@/pages/accounts/index";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient();
const AUTH_BASE_URL = import.meta.env.VITE_TRACKSTACK_AUTH_URL ?? "";

// Extract the trackstack-auth token from the URL hash BEFORE AuthProvider
// reads localStorage. This runs synchronously at module load time, so
// AuthProvider will see the token. trackstack-auth's /google/callback
// redirects with #trackstack_token=... (see trackstack-auth/src/routes.ts).
(function extractGoogleToken() {
  const hash = window.location.hash;
  const match = hash.match(/trackstack_token=([^&]+)/);
  if (match) {
    localStorage.setItem("auth_token", match[1]);
    window.location.hash = "";
  }
})();

// There is no local /login page anymore -- the only login UI in the
// whole system is TrackStack Home's (per-tracker login pages were
// scrapped 2026-09-20). Once silent SSO has been tried and there's still
// no user, bounce the browser to Home with returnTo set to this exact
// URL, so a successful login there sends it right back here instead of
// dropping the user on Home's own dashboard.
function ProtectedRoutes() {
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !user) {
      redirectToLogin(AUTH_BASE_URL, window.location.href);
    }
  }, [isLoading, user]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/receipts" component={Receipts} />
        <Route path="/receipts/:id" component={ReceiptDetail} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/reconcile" component={Reconcile} />
        <Route path="/spending" component={Spending} />
        <Route path="/goals" component={Goals} />
        <Route path="/recurring" component={Recurring} />
        <Route path="/accounts" component={Accounts} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <ProtectedRoutes />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
