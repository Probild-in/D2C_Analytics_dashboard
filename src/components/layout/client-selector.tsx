import { Building2, Check, ChevronsUpDown, Globe2 } from "lucide-react";
import { CLIENTS } from "@/data/mock";
import { useApp } from "@/store/app-context";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const statusDot: Record<string, string> = {
  healthy: "bg-positive",
  attention: "bg-warning",
  critical: "bg-negative",
};

export function ClientSelector() {
  const { clientId, setClientId, client, isAllClients } = useApp();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface pl-1.5 pr-2 text-[12.5px] font-medium text-text-primary shadow-[var(--shadow-sm)] transition-colors hover:bg-surface-hover">
          {isAllClients ? (
            <span className="flex size-[22px] items-center justify-center rounded-[6px] bg-brand-subtle text-brand">
              <Globe2 className="size-3.5" />
            </span>
          ) : (
            <span className={cn("relative flex size-[22px] items-center justify-center rounded-[6px] text-[10px] font-bold text-white", client?.logoColor)}>
              {client?.logoInitial}
              <span className={cn("absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full ring-2 ring-surface", statusDot[client?.status ?? "healthy"])} />
            </span>
          )}
          <span className="max-w-[130px] truncate">{isAllClients ? "All Clients" : client?.name}</span>
          <ChevronsUpDown className="size-3.5 text-text-tertiary" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setClientId("all")} className="justify-between">
          <span className="flex items-center gap-2">
            <span className="flex size-6 items-center justify-center rounded-md bg-brand-subtle text-brand">
              <Globe2 className="size-3.5" />
            </span>
            <span>
              <span className="block font-medium">All Clients</span>
              <span className="block text-[11px] text-text-tertiary">Agency-level overview</span>
            </span>
          </span>
          {clientId === "all" && <Check className="size-4 text-brand" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Clients</DropdownMenuLabel>
        {CLIENTS.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => setClientId(c.id)} className="justify-between">
            <span className="flex items-center gap-2">
              <span className={cn("flex size-6 items-center justify-center rounded-md text-[11px] font-bold text-white", c.logoColor)}>
                {c.logoInitial}
              </span>
              <span>
                <span className="block font-medium">{c.name}</span>
                <span className="block text-[11px] text-text-tertiary">{c.category}</span>
              </span>
            </span>
            {clientId === c.id ? (
              <Check className="size-4 text-brand" />
            ) : (
              <span className={cn("size-1.5 rounded-full", statusDot[c.status])} />
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-text-secondary">
          <Building2 className="size-3.5" />
          Manage clients
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
