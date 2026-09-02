import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NameAvatar } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { CreativesGrid } from "@/components/dashboard/creatives-panel";
import { useApp } from "@/store/app-context";
import { getCampaigns, getCampaignActivity, getCreatives, relativeTime } from "@/data/mock";
import type { Campaign, CampaignActivity } from "@/data/types";
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber, cn } from "@/lib/utils";
import {
  Banknote,
  BadgeCheck,
  MessageSquarePlus,
  MousePointerClick,
  PenLine,
  Percent,
  Rocket,
  Search as SearchIcon,
  Send,
  Target,
  Wallet,
} from "lucide-react";

const STATUS_VARIANT: Record<string, "positive" | "neutral" | "warning" | "info"> = {
  Active: "positive",
  Paused: "neutral",
  "In Review": "warning",
  Completed: "info",
};

const ACTIVITY_ICON: Record<CampaignActivity["type"], React.ElementType> = {
  created: Rocket,
  note: MessageSquarePlus,
  response: Send,
  creative: PenLine,
  budget: Wallet,
  status: BadgeCheck,
};

export default function GoogleAds() {
  const { client, isAllClients } = useApp();
  const cid = isAllClients ? "abc-fashion" : client?.id ?? "abc-fashion";
  const campaigns = React.useMemo(() => getCampaigns(cid, "google"), [cid]);
  const [selectedCampaign, setSelectedCampaign] = React.useState<Campaign | null>(null);

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
                  <tr
                    key={c.id}
                    onClick={() => setSelectedCampaign(c)}
                    className="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-hover"
                  >
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

      <CampaignDetailDialog campaign={selectedCampaign} onOpenChange={(open) => !open && setSelectedCampaign(null)} />
    </Page>
  );
}

function CampaignDetailDialog({ campaign, onOpenChange }: { campaign: Campaign | null; onOpenChange: (open: boolean) => void }) {
  const baseActivity = React.useMemo(() => (campaign ? getCampaignActivity(campaign.id) : []), [campaign?.id]);
  const [localNotes, setLocalNotes] = React.useState<CampaignActivity[]>([]);
  const activity = [...baseActivity, ...localNotes.filter((n) => n.campaignId === campaign?.id)];
  const [draft, setDraft] = React.useState("");

  const sendNote = () => {
    if (!draft.trim() || !campaign) return;
    setLocalNotes((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, campaignId: campaign.id, type: "note", author: "You", authorRole: "client", message: draft.trim(), timestamp: new Date().toISOString() },
    ]);
    setDraft("");
  };

  return (
    <Dialog
      open={!!campaign}
      onOpenChange={(open) => {
        if (!open) setDraft("");
        onOpenChange(open);
      }}
    >
      <DialogContent className="max-w-lg">
        {campaign && (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between gap-2 pr-6">
                <DialogTitle className="truncate">{campaign.name}</DialogTitle>
                <Badge variant={STATUS_VARIANT[campaign.status]} dot className="shrink-0">
                  {campaign.status}
                </Badge>
              </div>
              <DialogDescription>{campaign.resultType}</DialogDescription>
            </DialogHeader>

            <div className="px-5 pb-5">
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                <MetricTile label="Spend" value={formatCurrencyCompact(campaign.spend)} />
                <MetricTile label="Impressions" value={formatCompact(campaign.impressions)} />
                <MetricTile label="Clicks" value={formatNumber(campaign.clicks)} />
                <MetricTile label="CTR" value={`${campaign.ctr}%`} />
                <MetricTile label="CPC" value={formatCurrency(campaign.cpc)} />
                <MetricTile label="CPM" value={formatCurrency(campaign.cpm)} />
                <MetricTile label={campaign.resultType} value={formatNumber(campaign.results)} />
                <MetricTile label="ROAS" value={`${campaign.roas.toFixed(2)}x`} tone={campaign.roas < 2.5 ? "negative" : "positive"} />
              </div>

              <div className="mt-4 border-t border-border-subtle pt-3">
                <Tabs defaultValue="activity">
                  <TabsList>
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                    <TabsTrigger value="creatives">Creatives</TabsTrigger>
                  </TabsList>

                  <TabsContent value="activity" className="mt-3">
                    <div className="scrollbar-thin max-h-[220px] space-y-3 overflow-y-auto pr-1">
                      {activity.map((a) => {
                        const Icon = ACTIVITY_ICON[a.type];
                        const isClient = a.authorRole === "client";
                        return (
                          <div key={a.id} className={cn("flex gap-2.5", isClient && "flex-row-reverse")}>
                            {a.authorRole === "system" ? (
                              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-text-tertiary">
                                <Icon className="size-3.5" />
                              </span>
                            ) : (
                              <NameAvatar name={a.author} className="size-6 shrink-0" />
                            )}
                            <div className={cn("max-w-[78%] rounded-[var(--radius-md)] px-3 py-2 text-[12px] leading-snug", isClient ? "bg-brand text-brand-text-on" : "bg-bg-subtle text-text-primary")}>
                              <p className="mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide opacity-70">
                                {a.author !== "System" && <Icon className="size-3" />}
                                {a.author}
                              </p>
                              <p>{a.message}</p>
                              <p className="mt-1 text-[10px] opacity-60">{relativeTime(a.timestamp)}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <div className="mt-3 flex items-end gap-2">
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="Leave feedback for the marketing team…"
                        rows={1}
                        className="flex-1 resize-none rounded-[var(--radius-md)] border border-border bg-surface px-2.5 py-2 text-[12.5px] text-text-primary outline-none placeholder:text-text-tertiary focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20"
                      />
                      <Button size="icon" onClick={sendNote} disabled={!draft.trim()}>
                        <Send className="size-4" />
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="creatives" className="mt-3">
                    <div className="scrollbar-thin max-h-[280px] overflow-y-auto pr-1">
                      <CreativesGrid creatives={getCreatives(campaign)} />
                    </div>
                  </TabsContent>
                </Tabs>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function MetricTile({ label, value, tone }: { label: string; value: string; tone?: "negative" | "positive" }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-bg-subtle p-2 text-center">
      <p className="text-[10.5px] text-text-tertiary">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-[12.5px] font-semibold tabular-nums",
          tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-text-primary",
        )}
      >
        {value}
      </p>
    </div>
  );
}
