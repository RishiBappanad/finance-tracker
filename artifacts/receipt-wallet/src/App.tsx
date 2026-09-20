import type { ComponentType } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import Accounts from "@/pages/accounts/index";
import Login from "@/pages/auth/login";
import Register from "@/pages/auth/register";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

const queryClient = new QueryClient();

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

function ProtectedRoutes() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <Redirect to="/login" />;
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
        <Route path="/accounts" component={Accounts} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

// Guards /login and /register the same way ProtectedRoutes guards
// everything else, just inverted: once `user` is set, get off this route.
// Without this, a user who becomes authenticated WHILE already sitting on
// /login -- the exact shape of the Google OAuth round trip, which lands
// back on whatever page "Continue with Google" was clicked from, i.e.
// /login itself -- stays stuck looking at the login form forever, even
// though extractGoogleToken() already stored a real, valid token: nothing
// in Login's own code reacts to auth state changing except its own
// handleSubmit's explicit setLocation("/") for the email/password path,
// and the plain <Route path="/login" component={Login} /> below doesn't
// care about auth state at all. Confirmed live 2026-09-20 (real account,
// real token landed in localStorage, page never left /login until a
// manual reload forced AuthProvider to re-mount and this same check --
// then already present in ProtectedRoutes, just not here -- to run).
function PublicOnlyRoute({ component: Component }: { component: ComponentType }) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (user) {
    return <Redirect to="/" />;
  }

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login">
        <PublicOnlyRoute component={Login} />
      </Route>
      <Route path="/register">
        <PublicOnlyRoute component={Register} />
      </Route>
      <Route component={ProtectedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
