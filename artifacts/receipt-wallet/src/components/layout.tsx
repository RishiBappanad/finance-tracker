import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Receipt, 
  ArrowLeftRight, 
  Building2,
  Wallet,
  PieChart,
  LogOut,
  Menu,
  X
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { AppSwitcher } from "@/components/app-switcher";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/receipts", label: "Receipts", icon: Receipt },
    { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
    { href: "/spending", label: "Cash Flow", icon: PieChart },
    { href: "/reconcile", label: "Reconcile", icon: Wallet },
    { href: "/accounts", label: "Accounts", icon: Building2 },
  ];

  const NavContent = () => (
    <>
      <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location === item.href || (item.href !== "/" && location.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 cursor-pointer",
                  isActive 
                    ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" 
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
                onClick={() => setMobileOpen(false)}
                data-testid={`nav-${item.label.toLowerCase()}`}
              >
                <item.icon className={cn("h-4 w-4", isActive ? "text-sidebar-primary" : "opacity-70")} />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-sidebar-border">
        <div className="px-3 py-2 text-xs text-sidebar-foreground/50 mb-1 truncate">
          {user?.email}
        </div>
        <div
          className="flex items-center gap-3 px-3 py-2 text-sm font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground cursor-pointer transition-colors rounded-md hover:bg-sidebar-accent/50"
          onClick={() => { logout(); setMobileOpen(false); }}
        >
          <LogOut className="h-4 w-4 opacity-70" />
          Sign Out
        </div>
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* App Switcher */}
      <AppSwitcher />

      {/* Desktop sidebar */}
      <aside className="w-64 flex-shrink-0 bg-sidebar border-r border-sidebar-border hidden md:flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-sidebar-border">
          <div className="flex items-center gap-2 text-sidebar-foreground">
            <Wallet className="h-5 w-5 text-sidebar-primary" />
            <span className="font-semibold text-lg tracking-tight">TrackStack</span>
          </div>
        </div>
        <NavContent />
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
          />
          {/* Drawer */}
          <aside className="absolute left-0 top-0 bottom-0 w-72 bg-sidebar border-r border-sidebar-border flex flex-col animate-in slide-in-from-left duration-200">
            <div className="h-16 flex items-center justify-between px-6 border-b border-sidebar-border">
              <div className="flex items-center gap-2 text-sidebar-foreground">
                <Wallet className="h-5 w-5 text-sidebar-primary" />
                <span className="font-semibold text-lg tracking-tight">TrackStack</span>
              </div>
              <button onClick={() => setMobileOpen(false)} className="text-sidebar-foreground/70">
                <X className="h-5 w-5" />
              </button>
            </div>
            <NavContent />
          </aside>
        </div>
      )}
      
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile header */}
        <header className="h-14 md:hidden flex items-center px-4 border-b border-border bg-card gap-3">
          <button onClick={() => setMobileOpen(true)} className="p-1">
            <Menu className="h-5 w-5" />
          </button>
          <Wallet className="h-5 w-5 text-primary" />
          <span className="font-semibold text-lg">TrackStack</span>
        </header>
        
        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
