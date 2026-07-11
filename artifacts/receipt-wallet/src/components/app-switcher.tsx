import { useState, useEffect } from "react";
import { Wallet, Apple, LayoutDashboard, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppEntry {
  id: string;
  label: string;
  icon: string;
  href: string;
}

const ICON_MAP: Record<string, LucideIcon> = {
  Wallet,
  Apple,
  LayoutDashboard,
};

const CURRENT_APP = "finance";

export function AppSwitcher() {
  const [apps, setApps] = useState<AppEntry[]>([]);

  useEffect(() => {
    fetch("/apps.json")
      .then((r) => r.json())
      .then(setApps)
      .catch(() => {});
  }, []);

  if (apps.length === 0) return null;

  return (
    <aside className="w-16 flex-shrink-0 bg-sidebar border-r border-sidebar-border hidden md:flex flex-col items-center py-4 gap-3">
      {apps.map((app) => {
        const Icon = ICON_MAP[app.icon] || LayoutDashboard;
        const isActive = app.id === CURRENT_APP;
        return (
          <a
            key={app.id}
            href={app.href}
            title={app.label}
            className={cn(
              "w-10 h-10 rounded-lg flex items-center justify-center transition-all duration-200",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground ring-2 ring-sidebar-ring"
                : "text-sidebar-foreground/50 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
            )}
          >
            <Icon className="h-5 w-5" />
          </a>
        );
      })}
    </aside>
  );
}
