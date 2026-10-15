import * as React from "react";
import { Bell, TrendingDown, Wallet, Gauge, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiFetch, subscribeToNotificationStream } from "@/lib/api";

type NotificationKind = "rto" | "sales" | "ads" | "roas" | "task";

interface AppNotification {
  id: string;
  clientId: string;
  clientName: string;
  kind: NotificationKind;
  title: string;
  description: string;
  createdAt: string;
  read: boolean;
}

const KIND_META: Record<NotificationKind, { icon: React.ElementType; className: string }> = {
  rto: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  sales: { icon: Gauge, className: "bg-warning-subtle text-warning" },
  ads: { icon: Wallet, className: "bg-info-subtle text-info" },
  roas: { icon: TrendingDown, className: "bg-negative-subtle text-negative" },
  task: { icon: ListChecks, className: "bg-brand-subtle text-brand" },
};

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function NotificationsMenu() {
  const [notifications, setNotifications] = React.useState<AppNotification[]>([]);
  const unread = notifications.filter((n) => !n.read).length;

  React.useEffect(() => {
    apiFetch("/api/notifications")
      .then((res) => res.json())
      .then(setNotifications)
      .catch(() => {});

    const unsubscribe = subscribeToNotificationStream((data) => {
      const n = data as AppNotification;
      setNotifications((prev) => [{ ...n, read: false }, ...prev]);
    });
    return unsubscribe;
  }, []);

  const markAllRead = () => {
    const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    unreadIds.forEach((id) => apiFetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {}));
  };

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((x) => (x.id === id ? { ...x, read: true } : x)));
    apiFetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  };

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
          {notifications.length === 0 && (
            <div className="px-3.5 py-6 text-center text-[12px] text-text-secondary">No notifications yet.</div>
          )}
          {notifications.map((n) => {
            const meta = KIND_META[n.kind];
            const Icon = meta.icon;
            return (
              <button
                key={n.id}
                onClick={() => markRead(n.id)}
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
                    <span className="font-medium text-text-primary">{n.clientName}</span> {n.description}
                  </span>
                  <span className="mt-1 block text-[10.5px] text-text-tertiary">{relativeTime(n.createdAt)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
