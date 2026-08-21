import * as React from "react";
import { Bell, Megaphone, TrendingDown, Wallet, Gauge, ListChecks, Info } from "lucide-react";
import { getNotifications, relativeTime, CLIENTS } from "@/data/mock";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AlertKind } from "@/data/types";

const KIND_META: Record<AlertKind, { icon: React.ElementType; className: string }> = {
  rto: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  sales: { icon: Gauge, className: "bg-warning-subtle text-warning" },
  ads: { icon: Wallet, className: "bg-info-subtle text-info" },
  roas: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  task: { icon: ListChecks, className: "bg-brand-subtle text-brand" },
  campaign: { icon: Megaphone, className: "bg-[oklch(0.94_0.03_302)] text-accent-violet dark:bg-[oklch(0.3_0.08_302)]" },
  system: { icon: Info, className: "bg-bg-subtle text-text-secondary" },
};

export function NotificationsMenu() {
  const [notifications, setNotifications] = React.useState(getNotifications);
  const unread = notifications.filter((n) => !n.read).length;

  const markAllRead = () => setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="relative flex size-8 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary">
          <Bell className="size-[17px]" />
          {unread > 0 && (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-negative text-[9px] font-bold text-white ring-2 ring-surface">
              {unread}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px] p-0">
        <div className="flex items-center justify-between border-b border-border-subtle px-3.5 py-2.5">
          <span className="text-[13px] font-semibold">Notifications</span>
          <Button variant="ghost" size="xs" onClick={markAllRead} className="h-6 px-1.5 text-[11px]">
            Mark all read
          </Button>
        </div>
        <div className="scrollbar-thin max-h-[420px] overflow-y-auto">
          {notifications.map((n) => {
            const meta = KIND_META[n.kind];
            const Icon = meta.icon;
            const client = CLIENTS.find((c) => c.id === n.clientId);
            return (
              <button
                key={n.id}
                onClick={() => setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)))}
                className={cn(
                  "flex w-full items-start gap-2.5 border-b border-border-subtle px-3.5 py-2.5 text-left transition-colors last:border-0 hover:bg-surface-hover",
                  !n.read && "bg-brand-subtle/30",
                )}
              >
                <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md", meta.className)}>
                  <Icon className="size-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12.5px] font-medium text-text-primary">{n.title}</span>
                    {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-brand" />}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-text-secondary">
                    {client && <span className="font-medium text-text-primary">{client.name}</span>} {n.description}
                  </span>
                  <span className="mt-1 block text-[10.5px] text-text-tertiary">{relativeTime(n.timestamp)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="border-t border-border-subtle p-2 text-center">
          <Button variant="ghost" size="sm" className="w-full text-[12px]">
            View all notifications
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
