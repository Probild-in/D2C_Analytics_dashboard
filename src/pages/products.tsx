import * as React from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartTooltip } from "@/components/dashboard/chart-tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useApp } from "@/store/app-context";
import { useClientResource } from "@/hooks/use-client-resource";
import type { Product } from "@/data/types";
import { formatCurrencyCompact, formatNumber, formatPercent, cn } from "@/lib/utils";
import { Package, ShoppingBag, TrendingUp, Undo2 } from "lucide-react";

const EMPTY_PRODUCTS: Product[] = [];

export default function Products() {
  const { client, isAllClients } = useApp();
  const { data: products } = useClientResource<Product[]>(
    !isAllClients && client ? `/api/clients/${client.id}/products` : null,
    EMPTY_PRODUCTS,
  );
  const [selectedProduct, setSelectedProduct] = React.useState<Product | null>(null);

  const totalOrders = products.reduce((s, p) => s + p.orders, 0);
  const totalNetSales = products.reduce((s, p) => s + p.netSales, 0);
  const avgRto = products.length > 0 ? products.reduce((s, p) => s + p.rtoPercent, 0) / products.length : 0;

  return (
    <Page title="Products" description={isAllClients ? "Product performance (showing ABC Fashion catalog)" : `${client?.name} — product performance`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Active Products" value={String(products.length)} icon={<Package />} accent="brand" />
        <KpiCard label="Total Orders" value={formatNumber(totalOrders)} icon={<ShoppingBag />} accent="cyan" />
        <KpiCard label="Net Sales" value={formatCurrencyCompact(totalNetSales)} icon={<TrendingUp />} accent="positive" />
        <KpiCard label="Avg RTO %" value={formatPercent(avgRto)} invertColor icon={<Undo2 />} accent="warning" />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Product performance</CardTitle>
          <CardDescription>Sorted by net sales, with RTO and cancellation breakdown</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2.5 font-medium">Product</th>
                  <th className="px-3 py-2.5 font-medium">Orders</th>
                  <th className="px-3 py-2.5 font-medium">Sales</th>
                  <th className="px-3 py-2.5 font-medium">Net Sales</th>
                  <th className="px-3 py-2.5 font-medium">RTO %</th>
                  <th className="px-3 py-2.5 font-medium">Cancel %</th>
                  <th className="px-4 py-2.5 font-medium">12-week trend</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => setSelectedProduct(p)}
                    className="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold", p.image)}>
                          {p.name.slice(0, 2).toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium text-text-primary">{p.name}</p>
                          <p className="text-[11px] text-text-tertiary">{p.category}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(p.orders)}</td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatCurrencyCompact(p.sales)}</td>
                    <td className="px-3 py-2.5 font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(p.netSales)}</td>
                    <td className="px-3 py-2.5">
                      <span className={cn("font-medium tabular-nums", p.rtoPercent > 25 ? "text-negative" : "text-text-secondary")}>
                        {formatPercent(p.rtoPercent)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatPercent(p.cancellationPercent)}</td>
                    <td className="px-4 py-2.5">
                      <Sparkline data={p.trend} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <ProductDetailDialog product={selectedProduct} onOpenChange={(open) => !open && setSelectedProduct(null)} />
    </Page>
  );
}

function ProductDetailDialog({ product, onOpenChange }: { product: Product | null; onOpenChange: (open: boolean) => void }) {
  const chartData = product?.trend.map((v, i) => ({ week: `W${i + 1}`, Orders: v })) ?? [];

  return (
    <Dialog open={!!product} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {product && (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2.5 pr-6">
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold", product.image)}>
                  {product.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <DialogTitle className="truncate">{product.name}</DialogTitle>
                  <DialogDescription>{product.category}</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="Orders" value={formatNumber(product.orders)} />
                <StatTile label="Sales" value={formatCurrencyCompact(product.sales)} />
                <StatTile label="Net sales" value={formatCurrencyCompact(product.netSales)} />
                <StatTile label="RTO %" value={formatPercent(product.rtoPercent)} tone={product.rtoPercent > 25 ? "negative" : undefined} />
                <StatTile label="Cancel %" value={formatPercent(product.cancellationPercent)} />
                <StatTile label="Avg order value" value={formatCurrencyCompact(product.orders > 0 ? product.sales / product.orders : 0)} />
              </div>

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">12-week order trend</p>
                <ResponsiveContainer width="100%" height={120}>
                  <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
                    <defs>
                      <linearGradient id="productTrendFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-brand)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="var(--color-brand)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="week" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: "var(--color-text-tertiary)" }} minTickGap={20} />
                    <Tooltip cursor={{ stroke: "var(--color-border)", strokeDasharray: "4 4" }} content={<ChartTooltip formatter={(v) => formatNumber(v)} />} />
                    <Area type="monotone" dataKey="Orders" stroke="var(--color-brand)" strokeWidth={2} fill="url(#productTrendFill)" dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
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

function Sparkline({ data }: { data: number[] }) {
  const max = Math.max(...data);
  return (
    <div className="flex h-7 w-24 items-end gap-[2px]">
      {data.map((v, i) => (
        <div key={i} className="flex-1 rounded-[1px] bg-brand/70" style={{ height: `${Math.max(8, (v / max) * 100)}%` }} />
      ))}
    </div>
  );
}
