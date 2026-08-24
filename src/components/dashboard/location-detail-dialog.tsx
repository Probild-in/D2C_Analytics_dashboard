import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { formatCurrencyCompact, formatNumber, formatPercent, cn } from "@/lib/utils";
import type { GeoRow } from "@/data/types";
import { MapPin } from "lucide-react";

export function LocationDetailDialog({
  location,
  level,
  onOpenChange,
}: {
  location: GeoRow | null;
  level: "state" | "city";
  onOpenChange: (open: boolean) => void;
}) {
  const worse = location ? location.rtoPercent > location.previousRtoPercent : false;

  return (
    <Dialog open={!!location} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {location && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-6">
                <MapPin className="size-4 text-text-tertiary" />
                <DialogTitle>{location.name}</DialogTitle>
              </div>
              <DialogDescription>{level === "state" ? "State" : "City"}-level delivery & sales performance</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="Orders" value={formatNumber(location.orders)} />
                <StatTile label="Sales" value={formatCurrencyCompact(location.sales)} />
                <StatTile label="Delivered" value={formatNumber(location.delivered)} />
                <StatTile label="RTO orders" value={formatNumber(location.rto)} />
                <StatTile label="RTO %" value={formatPercent(location.rtoPercent)} tone={location.rtoPercent > 25 ? "negative" : undefined} />
                <StatTile label="Cancel %" value={formatPercent(location.cancellationPercent)} />
              </div>

              <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-3">
                <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">RTO trend</p>
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px] text-text-secondary">
                    Previous period: <span className="font-medium text-text-primary">{formatPercent(location.previousRtoPercent)}</span>
                  </span>
                  <span className={cn("text-[12.5px] font-semibold", worse ? "text-negative" : "text-positive")}>
                    {worse ? "▲" : "▼"} now at {formatPercent(location.rtoPercent)}
                  </span>
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: "negative" }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-2.5 text-center">
      <p className="text-[10.5px] text-text-tertiary">{label}</p>
      <p className={cn("mt-0.5 text-[13px] font-semibold tabular-nums", tone === "negative" ? "text-negative" : "text-text-primary")}>{value}</p>
    </div>
  );
}
