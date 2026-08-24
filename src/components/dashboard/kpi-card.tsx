import * as React from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export interface KpiCardProps {
  label: string;
  value: string;
  delta?: number;
  deltaLabel?: string;
  invertColor?: boolean;
  icon?: React.ReactNode;
  sparkline?: React.ReactNode;
  accent?: "brand" | "cyan" | "violet" | "positive" | "warning";
  className?: string;
  onClick?: () => void;
}

const accentMap: Record<NonNullable<KpiCardProps["accent"]>, string> = {
  brand: "bg-brand-subtle text-brand",
  cyan: "bg-info-subtle text-info",
  violet: "bg-[oklch(0.94_0.03_302)] text-accent-violet dark:bg-[oklch(0.3_0.08_302)]",
  positive: "bg-positive-subtle text-positive",
  warning: "bg-warning-subtle text-warning",
};

export function KpiCard({
  label,
  value,
  delta,
  deltaLabel = "vs prev period",
  invertColor = false,
  icon,
  sparkline,
  accent = "brand",
  className,
  onClick,
}: KpiCardProps) {
  const isFlat = delta === undefined || Math.abs(delta) < 0.05;
  const isPositive = !isFlat && (invertColor ? delta! < 0 : delta! > 0);

  return (
    <Card
      onClick={onClick}
      className={cn(
        "group relative overflow-hidden p-4 transition-all",
        onClick && "cursor-pointer hover:border-border hover:shadow-[var(--shadow-md)]",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <span className="text-[12px] font-medium text-text-secondary">{label}</span>
        {icon && (
          <span className={cn("flex size-6 items-center justify-center rounded-md [&_svg]:size-3.5", accentMap[accent])}>
            {icon}
          </span>
        )}
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <span className="text-[22px] font-semibold tracking-[-0.02em] text-text-primary tabular-nums">{value}</span>
        {sparkline && <div className="mb-0.5 h-8 w-20 shrink-0">{sparkline}</div>}
      </div>

      {delta !== undefined && (
        <div className="mt-2 flex items-center gap-1 text-[11.5px]">
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded font-medium",
              isFlat
                ? "text-text-tertiary"
                : isPositive
                  ? "text-positive"
                  : "text-negative",
            )}
          >
            {isFlat ? <Minus className="size-3" /> : delta! > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
            {Math.abs(delta!).toFixed(1)}%
          </span>
          <span className="text-text-tertiary">{deltaLabel}</span>
        </div>
      )}
    </Card>
  );
}
