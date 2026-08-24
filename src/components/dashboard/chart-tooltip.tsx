import { cn } from "@/lib/utils";

interface ChartTooltipProps {
  active?: boolean;
  label?: string;
  payload?: { name: string; value: number; color?: string; unit?: string }[];
  formatter?: (value: number, name: string) => string;
  labelFormatter?: (label: string) => string;
}

export function ChartTooltip({ active, label, payload, formatter, labelFormatter }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;

  return (
    <div className="min-w-[150px] rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2 shadow-[var(--shadow-popover)]">
      {label && (
        <div className="mb-1.5 text-[11px] font-medium text-text-tertiary">
          {labelFormatter ? labelFormatter(label) : label}
        </div>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center justify-between gap-4 text-[12px]">
            <span className="flex items-center gap-1.5 text-text-secondary">
              <span className={cn("size-2 rounded-[3px]")} style={{ backgroundColor: p.color }} />
              {p.name}
            </span>
            <span className="font-semibold tabular-nums text-text-primary">
              {formatter ? formatter(p.value, p.name) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
