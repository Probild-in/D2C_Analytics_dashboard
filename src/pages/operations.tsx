import * as React from "react";
import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle, IndianRupee, PackageX, PercentCircle, Truck } from "lucide-react";
import { Page } from "@/components/layout/app-shell";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartTooltip } from "@/components/dashboard/chart-tooltip";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { LocationDetailDialog } from "@/components/dashboard/location-detail-dialog";
import { useApp } from "@/store/app-context";
import { usePeriodData, deriveMetrics } from "@/hooks/use-period-data";
import { percentDelta } from "@/lib/date-range";
import { formatCurrencyCompact, formatNumber, formatPercent, cn } from "@/lib/utils";
import { getCourierBreakdown } from "@/data/mock";
import { useClientResource } from "@/hooks/use-client-resource";
import type { OrderStatus, GeoRow, Order } from "@/data/types";
import { Truck as TruckIcon } from "lucide-react";

const EMPTY_ORDERS: Order[] = [];
const EMPTY_GEO: GeoRow[] = [];

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

const STATUS_FLOW: { status: OrderStatus; color: string }[] = [
  { status: "Dispatched", color: "bg-slate-400" },
  { status: "In Transit", color: "bg-info" },
  { status: "Out for Delivery", color: "bg-accent-violet" },
  { status: "Delivered", color: "bg-positive" },
  { status: "NDR", color: "bg-warning" },
  { status: "RTO Initiated", color: "bg-orange-500" },
  { status: "RTO Delivered", color: "bg-negative" },
  { status: "Cancelled", color: "bg-text-tertiary" },
];

export default function Operations() {
  const { client, isAllClients } = useApp();
  const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";
  const { current, currentSum, previousSum } = usePeriodData();
  const metrics = deriveMetrics(currentSum);
  const prevMetrics = deriveMetrics(previousSum);

  const { data: orders } = useClientResource<Order[]>(
    !isAllClients && client ? `/api/clients/${client.id}/orders?limit=200` : null,
    EMPTY_ORDERS,
  );
  const statusCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) counts[o.status] = (counts[o.status] ?? 0) + 1;
    return counts;
  }, [orders]);
  const maxCount = Math.max(...Object.values(statusCounts), 1);

  const { data: statesRaw } = useClientResource<GeoRow[]>(
    !isAllClients && client ? `/api/clients/${client.id}/geography?level=state` : null,
    EMPTY_GEO,
  );
  const states = statesRaw.slice(0, 8);
  const couriers = React.useMemo(() => getCourierBreakdown(cid), [cid]);
  const [selectedState, setSelectedState] = React.useState<GeoRow | null>(null);
  const [selectedCourier, setSelectedCourier] = React.useState<(typeof couriers)[number] | null>(null);

  const rtoValue = Math.round(currentSum.rtoOrders * metrics.aov * 0.65);
  const ndrOrders = statusCounts["NDR"] ?? 0;

  const chartData = current.map((p) => ({
    date: dateFmt.format(new Date(p.date)),
    "RTO %": p.orders > 0 ? Math.round((p.rtoOrders / p.orders) * 1000) / 10 : 0,
  }));

  return (
    <Page title="Operations & RTO" description={isAllClients ? "Delivery performance across all clients" : `${client?.name} — delivery & RTO performance`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="RTO %" value={formatPercent(metrics.rtoPercent)} delta={percentDelta(metrics.rtoPercent, prevMetrics.rtoPercent)} invertColor icon={<PercentCircle />} accent="warning" />
        <KpiCard label="RTO Orders" value={formatNumber(currentSum.rtoOrders)} delta={percentDelta(currentSum.rtoOrders, previousSum.rtoOrders)} invertColor icon={<Truck />} accent="warning" />
        <KpiCard label="RTO Value" value={formatCurrencyCompact(rtoValue)} invertColor delta={2.1} icon={<IndianRupee />} accent="warning" />
        <KpiCard label="NDR Orders" value={formatNumber(ndrOrders)} icon={<AlertTriangle />} accent="brand" />
        <KpiCard label="Cancellation %" value={formatPercent(metrics.cancellationPercent)} delta={percentDelta(metrics.cancellationPercent, prevMetrics.cancellationPercent)} invertColor icon={<PackageX />} accent="cyan" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Delivery funnel</CardTitle>
            <CardDescription>Order status distribution</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {STATUS_FLOW.map(({ status, color }) => {
              const count = statusCounts[status] ?? 0;
              return (
                <div key={status}>
                  <div className="mb-1 flex items-center justify-between text-[11.5px]">
                    <span className="font-medium text-text-secondary">{status}</span>
                    <span className="font-semibold tabular-nums text-text-primary">{count}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                    <div className={cn("h-full rounded-full", color)} style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>RTO % trend</CardTitle>
            <CardDescription>Daily return-to-origin rate over the selected period</CardDescription>
          </CardHeader>
          <CardContent className="pl-1 pr-3">
            <ResponsiveContainer width="100%" height={228}>
              <LineChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} width={36} tickFormatter={(v) => `${v}%`} />
                <Tooltip cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }} content={<ChartTooltip formatter={(v) => `${v}%`} />} />
                <Line type="monotone" dataKey="RTO %" stroke="var(--color-negative)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>RTO by state</CardTitle>
            <CardDescription>States with highest return rates</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2 font-medium">State</th>
                  <th className="px-3 py-2 font-medium">Orders</th>
                  <th className="px-3 py-2 font-medium">RTO %</th>
                  <th className="px-4 py-2 font-medium">Trend</th>
                </tr>
              </thead>
              <tbody>
                {states.map((s) => {
                  const worse = s.rtoPercent > s.previousRtoPercent;
                  return (
                    <tr
                      key={s.name}
                      onClick={() => setSelectedState(s)}
                      className="cursor-pointer border-b border-border-subtle last:border-0 hover:bg-surface-hover"
                    >
                      <td className="px-4 py-2 font-medium text-text-primary">{s.name}</td>
                      <td className="px-3 py-2 tabular-nums text-text-secondary">{formatNumber(s.orders)}</td>
                      <td className="px-3 py-2">
                        <span className={cn("font-semibold tabular-nums", s.rtoPercent > 30 ? "text-negative" : s.rtoPercent > 20 ? "text-warning" : "text-text-primary")}>
                          {formatPercent(s.rtoPercent)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-[11px]">
                        <span className={worse ? "text-negative" : "text-positive"}>
                          {worse ? "▲" : "▼"} vs {formatPercent(s.previousRtoPercent)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Courier performance</CardTitle>
            <CardDescription>Delivery reliability by courier partner</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2 font-medium">Courier</th>
                  <th className="px-3 py-2 font-medium">Orders</th>
                  <th className="px-3 py-2 font-medium">RTO %</th>
                  <th className="px-4 py-2 font-medium">Avg days</th>
                </tr>
              </thead>
              <tbody>
                {couriers.map((c) => (
                  <tr
                    key={c.name}
                    onClick={() => setSelectedCourier(c)}
                    className="cursor-pointer border-b border-border-subtle last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2 font-medium text-text-primary">{c.name}</td>
                    <td className="px-3 py-2 tabular-nums text-text-secondary">{formatNumber(c.orders)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("font-semibold tabular-nums", c.rtoPercent > 25 ? "text-negative" : "text-text-primary")}>
                        {formatPercent(c.rtoPercent)}
                      </span>
                    </td>
                    <td className="px-4 py-2 tabular-nums text-text-secondary">{c.avgDeliveryDays}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <LocationDetailDialog location={selectedState} level="state" onOpenChange={(open) => !open && setSelectedState(null)} />
      <CourierDetailDialog courier={selectedCourier} onOpenChange={(open) => !open && setSelectedCourier(null)} />
    </Page>
  );
}

function CourierDetailDialog({
  courier,
  onOpenChange,
}: {
  courier: ReturnType<typeof getCourierBreakdown>[number] | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!courier} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {courier && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 pr-6">
                <TruckIcon className="size-4 text-text-tertiary" />
                <DialogTitle>{courier.name}</DialogTitle>
              </div>
              <DialogDescription>Courier delivery performance</DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-2 px-5 pb-5">
              <CourierStat label="Orders" value={formatNumber(courier.orders)} />
              <CourierStat label="Delivered" value={formatNumber(courier.delivered)} />
              <CourierStat label="RTO %" value={formatPercent(courier.rtoPercent)} tone={courier.rtoPercent > 25 ? "negative" : undefined} />
              <CourierStat label="NDR %" value={formatPercent(courier.ndrPercent)} tone={courier.ndrPercent > 8 ? "warning" : undefined} />
              <CourierStat label="Avg delivery time" value={`${courier.avgDeliveryDays}d`} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CourierStat({ label, value, tone }: { label: string; value: string; tone?: "negative" | "warning" }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-2.5 text-center">
      <p className="text-[10.5px] text-text-tertiary">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-[13px] font-semibold tabular-nums",
          tone === "negative" ? "text-negative" : tone === "warning" ? "text-warning" : "text-text-primary",
        )}
      >
        {value}
      </p>
    </div>
  );
}
