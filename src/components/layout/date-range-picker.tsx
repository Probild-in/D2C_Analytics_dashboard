import { Calendar, Check } from "lucide-react";
import { useApp, DATE_RANGE_LABELS, type DateRangeKey } from "@/store/app-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ORDER: DateRangeKey[] = ["today", "yesterday", "7d", "30d", "mtd", "ytd", "custom"];

export function DateRangePicker() {
  const { dateRange, setDateRange } = useApp();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex h-8 items-center gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-2.5 text-[12.5px] font-medium text-text-primary shadow-[var(--shadow-sm)] transition-colors hover:bg-surface-hover">
          <Calendar className="size-3.5 text-text-tertiary" />
          {DATE_RANGE_LABELS[dateRange]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {ORDER.map((key) => (
          <div key={key}>
            {key === "custom" && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={() => setDateRange(key)} className="justify-between">
              {DATE_RANGE_LABELS[key]}
              {dateRange === key && <Check className="size-3.5 text-brand" />}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
