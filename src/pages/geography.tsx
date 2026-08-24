import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LocationDetailDialog } from "@/components/dashboard/location-detail-dialog";
import { useApp } from "@/store/app-context";
import { getGeoBreakdown } from "@/data/mock";
import type { GeoRow } from "@/data/types";
import { formatCurrencyCompact, formatNumber, formatPercent, cn } from "@/lib/utils";
import { MapPin } from "lucide-react";

export default function Geography() {
  const { client, isAllClients } = useApp();
  const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";
  const [level, setLevel] = React.useState<"state" | "city">("state");
  const rows = React.useMemo(() => getGeoBreakdown(cid, level), [cid, level]);
  const maxSales = Math.max(...rows.map((r) => r.sales));
  const [selectedRow, setSelectedRow] = React.useState<GeoRow | null>(null);

  return (
    <Page title="Geography" description={isAllClients ? "Location performance (showing ABC Fashion)" : `${client?.name} — performance by location`}>
      <Card>
        <CardHeader className="items-center">
          <div>
            <CardTitle>Location breakdown</CardTitle>
            <CardDescription>Orders, sales and delivery performance by {level}</CardDescription>
          </div>
          <Tabs value={level} onValueChange={(v) => setLevel(v as typeof level)}>
            <TabsList>
              <TabsTrigger value="state">State</TabsTrigger>
              <TabsTrigger value="city">City</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2.5 font-medium">{level === "state" ? "State" : "City"}</th>
                  <th className="px-3 py-2.5 font-medium">Orders</th>
                  <th className="px-3 py-2.5 font-medium">Sales</th>
                  <th className="px-3 py-2.5 font-medium">Delivered</th>
                  <th className="px-3 py-2.5 font-medium">RTO %</th>
                  <th className="px-3 py-2.5 font-medium">Cancel %</th>
                  <th className="px-4 py-2.5 font-medium">Share of sales</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.name}
                    onClick={() => setSelectedRow(r)}
                    className="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-1.5 font-medium text-text-primary">
                        <MapPin className="size-3.5 text-text-tertiary" />
                        {r.name}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(r.orders)}</td>
                    <td className="px-3 py-2.5 font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(r.sales)}</td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(r.delivered)}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn("font-medium tabular-nums", r.rtoPercent > 30 ? "text-negative" : r.rtoPercent > 20 ? "text-warning" : "text-text-secondary")}>
                        {formatPercent(r.rtoPercent)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatPercent(r.cancellationPercent)}</td>
                    <td className="px-4 py-2.5">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-subtle">
                        <div className="h-full rounded-full bg-brand" style={{ width: `${(r.sales / maxSales) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <LocationDetailDialog location={selectedRow} level={level} onOpenChange={(open) => !open && setSelectedRow(null)} />
    </Page>
  );
}
