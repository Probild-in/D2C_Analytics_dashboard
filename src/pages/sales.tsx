import * as React from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Banknote, IndianRupee, Percent, ShoppingCart, Wallet, XCircle } from "lucide-react";
import { Page } from "@/components/layout/app-shell";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartTooltip } from "@/components/dashboard/chart-tooltip";
import { OrderStatusBadge } from "@/components/dashboard/status-badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useApp } from "@/store/app-context";
import { usePeriodData, deriveMetrics } from "@/hooks/use-period-data";
import { percentDelta } from "@/lib/date-range";
import { formatCurrency, formatCurrencyCompact, formatNumber, formatPercent } from "@/lib/utils";
import { getOrders, getProducts } from "@/data/mock";
import { Search } from "lucide-react";

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" });

export default function Sales() {
  const { client, isAllClients } = useApp();
  const { current, currentSum, previousSum } = usePeriodData();
  const metrics = deriveMetrics(currentSum);
  const prevMetrics = deriveMetrics(previousSum);
  const [query, setQuery] = React.useState("");

  const orders = React.useMemo(() => getOrders(isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion", 40), [client, isAllClients]);
  const filteredOrders = orders.filter(
    (o) => o.customer.toLowerCase().includes(query.toLowerCase()) || o.id.includes(query) || o.product.toLowerCase().includes(query.toLowerCase()),
  );
  const products = React.useMemo(() => getProducts(isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion"), [client, isAllClients]);

  const chartData = current.map((p) => ({
    date: dateFmt.format(new Date(p.date)),
    "Gross Sales": p.grossSales,
    "Net Sales": p.netSales,
  }));

  const cancelledValue = Math.round(currentSum.cancelledOrders * metrics.aov);

  return (
    <Page title="Shopify / Sales" description={isAllClients ? "Aggregated storefront performance" : `${client?.name} — Shopify store performance`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiCard label="Gross Sales" value={formatCurrencyCompact(currentSum.grossSales)} delta={percentDelta(currentSum.grossSales, previousSum.grossSales)} icon={<IndianRupee />} />
        <KpiCard label="Net Sales" value={formatCurrencyCompact(currentSum.netSales)} delta={percentDelta(currentSum.netSales, previousSum.netSales)} icon={<Wallet />} accent="positive" />
        <KpiCard label="Orders" value={formatNumber(currentSum.orders)} delta={percentDelta(currentSum.orders, previousSum.orders)} icon={<ShoppingCart />} accent="cyan" />
        <KpiCard label="AOV" value={formatCurrencyCompact(metrics.aov)} delta={percentDelta(metrics.aov, prevMetrics.aov)} icon={<Banknote />} accent="violet" />
        <KpiCard label="COD %" value={formatPercent(metrics.codPercent)} icon={<Percent />} accent="warning" />
        <KpiCard label="Cancelled Value" value={formatCurrencyCompact(cancelledValue)} invertColor delta={0.4} icon={<XCircle />} accent="warning" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Sales trend</CardTitle>
            <CardDescription>Gross vs net sales — discounts, cancellations &amp; RTO value deducted</CardDescription>
          </CardHeader>
          <CardContent className="pl-1 pr-3">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="grossFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-chart-2)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--color-chart-2)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="netFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} width={44} tickFormatter={(v) => formatCurrencyCompact(v)} />
                <Tooltip cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }} content={<ChartTooltip formatter={(v) => formatCurrencyCompact(v)} />} />
                <Area type="monotone" dataKey="Gross Sales" stroke="var(--color-chart-2)" strokeWidth={2} fill="url(#grossFill)" dot={false} />
                <Area type="monotone" dataKey="Net Sales" stroke="var(--color-chart-1)" strokeWidth={2} fill="url(#netFill)" dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
            <CardDescription>By net sales this period</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {products.slice(0, 6).map((p) => (
              <div key={p.id} className="flex items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1.5 transition-colors hover:bg-surface-hover">
                <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${p.image}`}>
                  {p.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-text-primary">{p.name}</p>
                  <p className="text-[11px] text-text-tertiary">{formatNumber(p.orders)} orders</p>
                </div>
                <span className="text-[12px] font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(p.netSales)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader className="items-center">
          <div>
            <CardTitle>Recent orders</CardTitle>
            <CardDescription>Latest orders across all statuses</CardDescription>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
            <Input placeholder="Search orders…" className="w-52 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2.5 font-medium">Order</th>
                  <th className="px-3 py-2.5 font-medium">Customer</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Product</th>
                  <th className="px-3 py-2.5 font-medium">Amount</th>
                  <th className="px-3 py-2.5 font-medium">Payment</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredOrders.slice(0, 12).map((o) => (
                  <tr key={o.id} className="border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover">
                    <td className="px-4 py-2.5 font-medium text-text-primary">{o.id}</td>
                    <td className="px-3 py-2.5 text-text-secondary">{o.customer}</td>
                    <td className="px-3 py-2.5 text-text-tertiary">{dateFmt.format(new Date(o.date))}</td>
                    <td className="max-w-[180px] truncate px-3 py-2.5 text-text-secondary">{o.product}</td>
                    <td className="px-3 py-2.5 font-medium tabular-nums text-text-primary">{formatCurrency(o.amount)}</td>
                    <td className="px-3 py-2.5">
                      <Badge variant={o.payment === "COD" ? "warning" : "info"}>{o.payment}</Badge>
                    </td>
                    <td className="px-3 py-2.5">
                      <OrderStatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5">
            <span className="text-[11.5px] text-text-tertiary">
              Showing {Math.min(12, filteredOrders.length)} of {filteredOrders.length} orders
            </span>
            <Button variant="outline" size="sm">
              View all orders
            </Button>
          </div>
        </CardContent>
      </Card>
    </Page>
  );
}
