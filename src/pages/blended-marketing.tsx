import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from "recharts";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { ChartTooltip } from "@/components/dashboard/chart-tooltip";
import { useApp } from "@/store/app-context";
import { usePeriodData, deriveMetrics } from "@/hooks/use-period-data";
import { useClientResource } from "@/hooks/use-client-resource";
import { formatCurrencyCompact, formatNumber } from "@/lib/utils";
import { Banknote, IndianRupee, Target, Users } from "lucide-react";
import type { Campaign } from "@/data/types";

const EMPTY_CAMPAIGNS: Campaign[] = [];

export default function BlendedMarketing() {
  const { client, isAllClients } = useApp();
  const { currentSum } = usePeriodData();
  const metrics = deriveMetrics(currentSum);

  const { data: metaCampaigns } = useClientResource<Campaign[]>(
    !isAllClients && client ? `/api/clients/${client.id}/campaigns?platform=meta` : null,
    EMPTY_CAMPAIGNS,
  );
  const { data: googleCampaigns } = useClientResource<Campaign[]>(
    !isAllClients && client ? `/api/clients/${client.id}/campaigns?platform=google` : null,
    EMPTY_CAMPAIGNS,
  );
  const metaSpend = metaCampaigns.reduce((s, c) => s + c.spend, 0);
  const googleSpend = googleCampaigns.reduce((s, c) => s + c.spend, 0);
  const totalSpend = metaSpend + googleSpend;

  const chartData = [
    { name: "Meta Ads", Spend: metaSpend },
    { name: "Google Ads", Spend: googleSpend },
  ];

  return (
    <Page title="Blended Marketing" description={isAllClients ? "Combined Meta + Google performance" : `${client?.name} — combined marketing performance`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Ad Spend" value={formatCurrencyCompact(totalSpend)} icon={<Banknote />} accent="warning" />
        <KpiCard label="Blended ROAS" value={`${metrics.blendedRoas.toFixed(2)}x`} icon={<Target />} accent="positive" />
        <KpiCard label="Cost Per Order" value={formatCurrencyCompact(metrics.costPerOrder)} icon={<IndianRupee />} accent="brand" />
        <KpiCard label="Blended CAC" value={formatCurrencyCompact(metrics.blendedCac)} icon={<Users />} accent="violet" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Spend by channel</CardTitle>
            <CardDescription>Meta vs Google Ads spend this period</CardDescription>
          </CardHeader>
          <CardContent className="pl-1 pr-3">
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }} barSize={64}>
                <CartesianGrid vertical={false} stroke="var(--color-border-subtle)" />
                <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "var(--color-text-secondary)" }} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--color-text-tertiary)" }} width={44} tickFormatter={(v) => formatCurrencyCompact(v)} />
                <Tooltip cursor={{ fill: "var(--color-bg-subtle)" }} content={<ChartTooltip formatter={(v) => formatCurrencyCompact(v)} />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Spend" radius={[6, 6, 0, 0]} fill="var(--color-chart-1)" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Formula reference</CardTitle>
            <CardDescription>How blended metrics are calculated</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <FormulaRow label="Total Ad Spend" formula="Meta Spend + Google Spend" />
            <FormulaRow label="Blended ROAS" formula="Net Sales ÷ Total Ad Spend" />
            <FormulaRow label="Cost Per Order" formula="Total Ad Spend ÷ Total Orders" />
            <FormulaRow label="Blended CAC" formula="Total Ad Spend ÷ New Customers" />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Channel comparison</CardTitle>
          <CardDescription>Meta vs Google performance summary</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                <th className="px-4 py-2.5 font-medium">Channel</th>
                <th className="px-3 py-2.5 font-medium">Spend</th>
                <th className="px-3 py-2.5 font-medium">Results</th>
                <th className="px-3 py-2.5 font-medium">Cost per result</th>
                <th className="px-4 py-2.5 font-medium">Share of spend</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: "Meta Ads", spend: metaSpend, results: metaCampaigns.reduce((s, c) => s + c.results, 0) },
                { name: "Google Ads", spend: googleSpend, results: googleCampaigns.reduce((s, c) => s + c.results, 0) },
              ].map((row) => (
                <tr key={row.name} className="border-b border-border-subtle last:border-0 hover:bg-surface-hover">
                  <td className="px-4 py-2.5 font-medium text-text-primary">{row.name}</td>
                  <td className="px-3 py-2.5 font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(row.spend)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(row.results)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-text-secondary">
                    {row.results > 0 ? formatCurrencyCompact(row.spend / row.results) : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-bg-subtle">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${totalSpend > 0 ? (row.spend / totalSpend) * 100 : 0}%` }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </Page>
  );
}

function FormulaRow({ label, formula }: { label: string; formula: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-bg-subtle p-2.5">
      <p className="text-[11.5px] font-semibold text-text-primary">{label}</p>
      <p className="mt-0.5 font-mono text-[11px] text-text-tertiary">{formula}</p>
    </div>
  );
}
