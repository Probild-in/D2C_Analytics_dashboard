import { NavLink } from "react-router-dom";
import { ChevronsLeft, Radar, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS } from "./nav-config";
import { useApp } from "@/store/app-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function Sidebar() {
  const { sidebarCollapsed, setSidebarCollapsed, mobileNavOpen, setMobileNavOpen } = useApp();

  return (
    <>
      {mobileNavOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setMobileNavOpen(false)}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex h-dvh flex-col border-r border-border-subtle bg-surface transition-all duration-200 lg:sticky lg:top-0 lg:z-0 lg:translate-x-0",
          sidebarCollapsed ? "lg:w-[68px]" : "lg:w-[236px]",
          "w-[236px]",
          mobileNavOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        <div className={cn("flex h-14 shrink-0 items-center gap-2 px-4", sidebarCollapsed && "lg:justify-center lg:px-0")}>
          <div className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-brand text-brand-text-on shadow-sm">
            <Radar className="size-4" />
          </div>
          {(!sidebarCollapsed || mobileNavOpen) && (
            <span className="text-[14.5px] font-semibold tracking-[-0.01em] text-text-primary lg:not-sr-only">
              <span className={cn(sidebarCollapsed && "lg:hidden")}>D2C</span>
            </span>
          )}
          <button
            onClick={() => setMobileNavOpen(false)}
            className="ml-auto rounded-md p-1 text-text-tertiary hover:bg-surface-hover lg:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="scrollbar-thin flex-1 space-y-4 overflow-y-auto px-2.5 py-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              {(!sidebarCollapsed || mobileNavOpen) && (
                <div className={cn("px-2 pb-1.5 pt-2 text-[10.5px] font-semibold uppercase tracking-wider text-text-tertiary", sidebarCollapsed && "lg:hidden")}>
                  {group.label}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <SidebarLink key={item.to} to={item.to} label={item.label} Icon={item.icon} collapsed={sidebarCollapsed && !mobileNavOpen} onNavigate={() => setMobileNavOpen(false)} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="hidden shrink-0 border-t border-border-subtle p-2 lg:block">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={cn(
              "flex h-8 w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 text-[12px] font-medium text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary",
              sidebarCollapsed && "justify-center",
            )}
          >
            <ChevronsLeft className={cn("size-4 shrink-0 transition-transform", sidebarCollapsed && "rotate-180")} />
            {!sidebarCollapsed && "Collapse"}
          </button>
        </div>
      </aside>
    </>
  );
}

function SidebarLink({
  to,
  label,
  Icon,
  collapsed,
  onNavigate,
}: {
  to: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  collapsed: boolean;
  onNavigate: () => void;
}) {
  const link = (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "group flex h-[34px] items-center gap-2.5 rounded-[var(--radius-md)] px-2.5 text-[12.5px] font-medium transition-colors",
          collapsed && "lg:justify-center lg:px-0",
          isActive
            ? "bg-brand-subtle text-brand"
            : "text-text-secondary hover:bg-surface-hover hover:text-text-primary",
        )
      }
    >
      <Icon className="size-[17px] shrink-0" />
      <span className={cn(collapsed && "lg:hidden")}>{label}</span>
    </NavLink>
  );

  if (!collapsed) return link;

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
