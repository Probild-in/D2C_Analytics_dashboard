import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { useApp } from "@/store/app-context";
import { getCampaigns } from "@/data/mock";
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber, cn } from "@/lib/utils";
import { Banknote, MousePointerClick, Percent, Search as SearchIcon, Target, Wallet } from "lucide-react";

const STATUS_VARIANT: Record<string, "positive" | "neutral" | "warning" | "info"> = {
  Active: "positive",
  Paused: "neutral",
  "In Review": "warning",
  Completed: "info",
};

export default function GoogleAds() {
  const { client, isAllClients } = useApp();
  const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";
  const campaigns = React.useMemo(() => getCampaigns(cid, "google"), [cid]);

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.spend += c.spend;
      acc.clicks += c.clicks;
      acc.impressions += c.impressions;
      acc.conversions += c.results;
      return acc;
    },
    { spend: 0, clicks: 0, impressions: 0, conversions: 0 },
  );
  const avgCpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0;
  const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;

  return (
    <Page title="Google Ads" description={isAllClients ? "Campaign performance (showing ABC Fashion)" : `${client?.name} — Google Ads performance`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCard label="Ad Spend" value={formatCurrencyCompact(totals.spend)} icon={<Banknote />} accent="warning" />
        <KpiCard label="Clicks" value={formatNumber(totals.clicks)} icon={<MousePointerClick />} accent="cyan" />
        <KpiCard label="Impressions" value={formatCompact(totals.impressions)} icon={<SearchIcon />} accent="violet" />
        <KpiCard label="Avg. CPC" value={formatCurrency(avgCpc)} icon={<Wallet />} accent="brand" />
        <KpiCard label="CTR" value={`${avgCtr.toFixed(2)}%`} icon={<Percent />} accent="positive" />
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle>Campaigns</CardTitle>
          <CardDescription>Search &amp; performance campaigns for the selected period</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="scrollbar-thin overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-border-subtle text-left text-[11px] uppercase tracking-wide text-text-tertiary">
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Spend</th>
                  <th className="px-3 py-2.5 font-medium">Clicks</th>
                  <th className="px-3 py-2.5 font-medium">CTR</th>
                  <th className="px-3 py-2.5 font-medium">Conversions</th>
                  <th className="px-4 py-2.5 font-medium">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover">
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-info-subtle text-info">
                          <Target className="size-3.5" />
                        </span>
                        <span className="font-medium text-text-primary">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_VARIANT[c.status]} dot>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 font-medium tabular-nums text-text-primary">{formatCurrencyCompact(c.spend)}</td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(c.clicks)}</td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{c.ctr}%</td>
                    <td className="px-3 py-2.5 tabular-nums text-text-secondary">{formatNumber(c.results)}</td>
                    <td className="px-4 py-2.5">
                      <span className={cn("font-semibold tabular-nums", c.roas < 2.5 ? "text-negative" : "text-positive")}>{c.roas.toFixed(2)}x</span>
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
