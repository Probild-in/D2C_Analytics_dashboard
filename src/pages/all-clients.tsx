import * as React from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Banknote, Building2, IndianRupee, ShoppingCart, Target, TrendingDown, TriangleAlert } from "lucide-react";
import { Page } from "@/components/layout/app-shell";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/store/app-context";
import { rangeToDays } from "@/lib/date-range";
import { useClientResource } from "@/hooks/use-client-resource";
import { formatCurrencyCompact, formatNumber, formatPercent } from "@/lib/utils";

const statusMeta: Record<string, { label: string; variant: "positive" | "warning" | "negative" }> = {
  healthy: { label: "Healthy", variant: "positive" },
  attention: { label: "Needs attention", variant: "warning" },
  critical: { label: "Critical", variant: "negative" },
};

interface ClientSummary {
  clientId: string;
  netSales: number;
  orders: number;
  rtoOrders: number;
  adSpend: number;
}

const EMPTY_SUMMARY: ClientSummary[] = [];

export default function AllClients() {
  const { clients, dateRange, setClientId } = useApp();
  const navigate = useNavigate();
  const days = rangeToDays(dateRange);
  const { data: summary } = useClientResource<ClientSummary[]>(`/api/clients/summary?days=${days}`, EMPTY_SUMMARY);

  const rows = React.useMemo(
    () =>
      clients
        .map((c) => {
          const sum = summary.find((s) => s.clientId === c.id) ?? { netSales: 0, orders: 0, rtoOrders: 0, adSpend: 0 };
          const rtoPercent = sum.orders > 0 ? (sum.rtoOrders / sum.orders) * 100 : 0;
          const blendedRoas = sum.adSpend > 0 ? sum.netSales / sum.adSpend : 0;
          return { client: c, sum, metrics: { rtoPercent, blendedRoas } };
        })
        .sort((a, b) => b.sum.netSales - a.sum.netSales),
    [clients, summary],
  );

  const totals = React.useMemo(
    () =>
      rows.reduce(
        (acc, r) => {
          acc.netSales += r.sum.netSales;
          acc.orders += r.sum.orders;
          acc.adSpend += r.sum.adSpend;
          acc.rtoOrders += r.sum.rtoOrders;
          return acc;
        },
        { netSales: 0, orders: 0, adSpend: 0, rtoOrders: 0 },
      ),
    [rows],
  );

  const avgRoas = totals.adSpend > 0 ? totals.netSales / totals.adSpend : 0;
  const overallRto = totals.orders > 0 ? (totals.rtoOrders / totals.orders) * 100 : 0;
  const needsAttention = clients.filter((c) => c.status !== "healthy").length;
  const worstRtoClient = rows.reduce<(typeof rows)[number] | null>(
    (worst, r) => (!worst || r.metrics.rtoPercent > worst.metrics.rtoPercent ? r : worst),
    null,
  );
  const showRtoAlert = worstRtoClient !== null && worstRtoClient.metrics.rtoPercent > 25;

  const openClient = (id: string) => {
    setClientId(id);
    navigate("/");
  };

  return (
    <Page title="All Clients" description="Agency-level overview across your entire portfolio">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Total Net Sales" value={formatCurrencyCompact(totals.netSales)} icon={<IndianRupee />} accent="brand" />
        <KpiCard label="Total Orders" value={formatNumber(totals.orders)} icon={<ShoppingCart />} accent="cyan" />
        <KpiCard label="Total Ad Spend" value={formatCurrencyCompact(totals.adSpend)} icon={<Banknote />} accent="warning" />
        <KpiCard label="Avg Blended ROAS" value={`${avgRoas.toFixed(2)}x`} icon={<Target />} accent="positive" />
        <KpiCard label="Overall RTO" value={formatPercent(overallRto)} icon={<TrendingDown />} accent="violet" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <div>
              <CardTitle>Client performance</CardTitle>
              <CardDescription>Click a client to open their full dashboard</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="scrollbar-thin overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
                <thead>
                  <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                    <th className="px-4 py-2.5 font-medium">Client</th>
                    <th className="px-3 py-2.5 font-medium">Net Sales</th>
                    <th className="px-3 py-2.5 font-medium">Orders</th>
                    <th className="px-3 py-2.5 font-medium">RTO</th>
                    <th className="px-3 py-2.5 font-medium">Ad Spend</th>
                    <th className="px-3 py-2.5 font-medium">ROAS</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ client, sum, metrics }) => (
                    <tr
                      key={client.id}
                      onClick={() => openClient(client.id)}
                      className="group cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover"
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className={`flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white ${client.logoColor}`}>
                            {client.logoInitial}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-medium text-text-primary">{client.name}</p>
                            <p className="truncate text-[11px] text-text-tertiary">{client.category}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(sum.netSales)}</td>
                      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(sum.orders)}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        <span className={metrics.rtoPercent > 28 ? "font-medium text-negative" : "text-text-secondary"}>
                          {formatPercent(metrics.rtoPercent)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatCurrencyCompact(sum.adSpend)}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        <span className={metrics.blendedRoas < 3 ? "font-medium text-warning" : "font-medium text-positive"}>
                          {metrics.blendedRoas.toFixed(2)}x
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge variant={statusMeta[client.status].variant} dot>
                          {statusMeta[client.status].label}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <ArrowUpRight className="size-4 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Portfolio health</CardTitle>
              <CardDescription>{needsAttention} of {clients.length} clients need attention</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1">
              {clients.map((c) => (
                <div
                  key={c.id}
                  onClick={() => openClient(c.id)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-md)] px-1.5 py-1.5 transition-colors hover:bg-surface-hover"
                >
                  <span className={`flex size-6 shrink-0 items-center justify-center rounded-md text-[10.5px] font-bold text-white ${c.logoColor}`}>
                    {c.logoInitial}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{c.name}</span>
                  <Badge variant={statusMeta[c.status].variant} dot>
                    {statusMeta[c.status].label}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className={showRtoAlert ? "border-warning/30 bg-warning-subtle/40" : ""}>
            <CardContent className="flex items-start gap-2.5 p-4">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div className="text-[12px] leading-snug text-text-secondary">
                {showRtoAlert && worstRtoClient ? (
                  <>
                    <p className="font-semibold text-text-primary">{worstRtoClient.client.name} needs review</p>
                    <p className="mt-0.5">
                      RTO at {formatPercent(worstRtoClient.metrics.rtoPercent)} this period. Consider reallocating ad budget.
                    </p>
                  </>
                ) : (
                  <p>No clients are showing elevated RTO this period.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-center gap-2.5 p-4">
              <Building2 className="size-4 shrink-0 text-text-tertiary" />
              <p className="text-[12px] text-text-secondary">
                Manage integrations and access from <span className="font-medium text-text-primary">Manage Clients</span>.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </Page>
  );
}
