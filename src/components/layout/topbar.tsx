import { Menu, Moon, Search, Sun } from "lucide-react";
import { useApp } from "@/store/app-context";
import { ClientSelector } from "./client-selector";
import { DateRangePicker } from "./date-range-picker";
import { NotificationsMenu } from "./notifications-menu";
import { NameAvatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function Topbar({ title, description }: { title: string; description?: string }) {
  const { theme, toggleTheme, setMobileNavOpen } = useApp();

  return (
    <header className="sticky top-0 z-30 border-b border-border-subtle bg-surface/85 backdrop-blur-md">
      <div className="flex h-14 shrink-0 items-center gap-3 px-4 lg:px-6">
        <button
          onClick={() => setMobileNavOpen(true)}
          className="flex size-8 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover lg:hidden"
        >
          <Menu className="size-[18px]" />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-text-primary">{title}</h1>
          {description && <p className="hidden truncate text-[11.5px] text-text-tertiary sm:block">{description}</p>}
        </div>

        <div className="hidden items-center md:flex">
          <ClientSelector />
        </div>

        <div className="hidden items-center lg:flex">
          <DateRangePicker />
        </div>

        <button className="hidden size-8 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary sm:flex">
          <Search className="size-[17px]" />
        </button>

        <button
          onClick={toggleTheme}
          className="flex size-8 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        >
          {theme === "light" ? <Moon className="size-[17px]" /> : <Sun className="size-[17px]" />}
        </button>

        <NotificationsMenu />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="ml-0.5 flex items-center gap-2 rounded-full outline-none ring-brand/40 focus-visible:ring-2">
              <NameAvatar name="Aishant Verma" className="size-8" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="normal-case tracking-normal text-text-primary">
              <span className="block text-[12.5px] font-semibold">Aishant Verma</span>
              <span className="block text-[11px] font-normal text-text-tertiary">Agency Owner</span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Account settings</DropdownMenuItem>
            <DropdownMenuItem>Billing</DropdownMenuItem>
            <DropdownMenuItem>Team members</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Below lg, the header doesn't have room for these — surface them in a secondary bar instead of hiding them outright */}
      <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-2 lg:hidden">
        <div className="md:hidden">
          <ClientSelector />
        </div>
        <DateRangePicker />
      </div>
    </header>
  );
}
