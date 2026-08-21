import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { useApp } from "@/store/app-context";
import { getProducts } from "@/data/mock";
import { formatCurrencyCompact, formatNumber, formatPercent, cn } from "@/lib/utils";
import { Package, ShoppingBag, TrendingUp, Undo2 } from "lucide-react";

export default function Products() {
  const { client, isAllClients } = useApp();
  const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";
  const products = React.useMemo(() => getProducts(cid), [cid]);

  const totalOrders = products.reduce((s, p) => s + p.orders, 0);
  const totalNetSales = products.reduce((s, p) => s + p.netSales, 0);
  const avgRto = products.reduce((s, p) => s + p.rtoPercent, 0) / products.length;

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
                  <tr key={p.id} className="border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover">
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
    </Page>
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
