import * as React from "react";
import { Page } from "@/components/layout/app-shell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { NameAvatar } from "@/components/ui/avatar";
import { CreativesGrid } from "@/components/dashboard/creatives-panel";
import { useApp } from "@/store/app-context";
import { useClientResource } from "@/hooks/use-client-resource";
import { supabase } from "@/lib/supabase";
import { relativeTime } from "@/data/mock";
import { formatCompact, formatCurrency, formatCurrencyCompact, formatNumber, cn } from "@/lib/utils";
import type { Campaign, CampaignActivity, Creative } from "@/data/types";
import {
  BadgeCheck,
  Banknote,
  Eye,
  MessageSquarePlus,
  MousePointerClick,
  PenLine,
  Rocket,
  Send,
  Target,
  Wallet,
} from "lucide-react";

const EMPTY_CAMPAIGNS: Campaign[] = [];
const EMPTY_CREATIVES: Creative[] = [];
const EMPTY_NOTES: CampaignActivity[] = [];

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

export default function MetaAds() {
  const { client, isAllClients } = useApp();
  const { data: campaigns } = useClientResource<Campaign[]>(
    !isAllClients && client ? `/api/clients/${client.id}/campaigns?platform=meta` : null,
    EMPTY_CAMPAIGNS,
  );
  const [selectedId, setSelectedId] = React.useState(campaigns[0]?.id);
  // Fall back to the first campaign whenever the stored selection isn't part
  // of the current client's list (e.g. after switching clients) — derived
  // directly during render instead of reset via an effect.
  const selected = campaigns.find((c) => c.id === selectedId) ?? campaigns[0];

  const { data: creatives } = useClientResource<Creative[]>(
    !isAllClients && client && selected ? `/api/clients/${client.id}/campaigns/${selected.id}/creatives` : null,
    EMPTY_CREATIVES,
  );
  const { data: notes } = useClientResource<CampaignActivity[]>(
    !isAllClients && client && selected ? `/api/clients/${client.id}/campaigns/${selected.id}/notes` : null,
    EMPTY_NOTES,
  );

  const [localNotes, setLocalNotes] = React.useState<CampaignActivity[]>([]);
  const activity = [...notes, ...localNotes.filter((n) => n.campaignId === selected?.id)];

  const [draft, setDraft] = React.useState("");
  const [posting, setPosting] = React.useState(false);
  const sendNote = async () => {
    if (!draft.trim() || !selected || !client) return;
    setPosting(true);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setPosting(false);
      return;
    }
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/api/clients/${client.id}/campaigns/${selected.id}/notes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim() }),
      });
      if (res.ok) {
        const created = await res.json();
        setLocalNotes((prev) => [...prev, created]);
        setDraft("");
      }
    } finally {
      setPosting(false);
    }
  };

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.spend += c.spend;
      acc.impressions += c.impressions;
      acc.clicks += c.clicks;
      acc.results += c.results;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, results: 0 },
  );
  const avgCtr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0;
  const avgRoas = campaigns.reduce((s, c) => s + c.roas, 0) / (campaigns.length || 1);

  return (
    <Page title="Meta Ads" description={isAllClients ? "Campaign performance" : `${client?.name} — Meta Ads performance & client review`}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Ad Spend" value={formatCurrencyCompact(totals.spend)} icon={<Banknote />} accent="warning" />
        <KpiCard label="Impressions" value={formatCompact(totals.impressions)} icon={<Eye />} accent="cyan" />
        <KpiCard label="CTR" value={`${avgCtr.toFixed(2)}%`} icon={<MousePointerClick />} accent="brand" />
        <KpiCard label="ROAS" value={`${avgRoas.toFixed(2)}x`} icon={<Target />} accent="positive" />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-5">
        <div className="space-y-2.5 xl:col-span-2">
          {campaigns.map((c) => (
            <Card
              key={c.id}
              onClick={() => setSelectedId(c.id)}
              className={cn(
                "cursor-pointer p-3 transition-all hover:border-brand/40",
                selectedId === c.id && "border-brand ring-1 ring-brand/30",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-[12.5px] font-semibold text-text-primary">{c.name}</p>
                  <Badge variant={STATUS_VARIANT[c.status]} dot className="shrink-0">
                    {c.status}
                  </Badge>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                  <div>
                    <p className="text-text-tertiary">Spend</p>
                    <p className="font-semibold tabular-nums text-text-primary">{formatCurrencyCompact(c.spend)}</p>
                  </div>
                  <div>
                    <p className="text-text-tertiary">{c.resultType}</p>
                    <p className="font-semibold tabular-nums text-text-primary">{formatNumber(c.results)}</p>
                  </div>
                  <div>
                    <p className="text-text-tertiary">ROAS</p>
                    <p className={cn("font-semibold tabular-nums", c.roas < 2.5 ? "text-negative" : "text-positive")}>{c.roas.toFixed(2)}x</p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>

        <Card className="flex flex-col xl:col-span-3">
          {selected && (
            <>
              <CardHeader className="items-start">
                <div>
                  <CardTitle>{selected.name}</CardTitle>
                  <CardDescription>{selected.resultType}</CardDescription>
                </div>
                <Badge variant={STATUS_VARIANT[selected.status]} dot>
                  {selected.status}
                </Badge>
              </CardHeader>

              <CardContent className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <MetricTile label="Impressions" value={formatNumber(selected.impressions)} />
                <MetricTile label="Clicks" value={formatNumber(selected.clicks)} />
                <MetricTile label="CTR" value={`${selected.ctr}%`} />
                <MetricTile label="CPC" value={formatCurrency(selected.cpc)} />
                <MetricTile label="CPM" value={formatCurrency(selected.cpm)} />
              </CardContent>

              <div className="mx-4 border-t border-border-subtle" />

              <CardContent className="flex-1">
                <Tabs defaultValue="activity">
                  <TabsList>
                    <TabsTrigger value="activity">Activity</TabsTrigger>
                    <TabsTrigger value="creatives">Creatives</TabsTrigger>
                  </TabsList>

                  <TabsContent value="activity" className="mt-3">
                    <div className="scrollbar-thin max-h-[280px] space-y-3 overflow-y-auto pr-1">
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
                              <p className={cn("mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide opacity-70")}>
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
                      <Button size="icon" onClick={sendNote} disabled={!draft.trim() || posting}>
                        <Send className="size-4" />
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="creatives" className="mt-3">
                    <div className="scrollbar-thin max-h-[340px] overflow-y-auto pr-1">
                      <CreativesGrid creatives={creatives} />
                    </div>
                  </TabsContent>
                </Tabs>
              </CardContent>
            </>
          )}
        </Card>
      </div>
    </Page>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] bg-bg-subtle p-2 text-center">
      <p className="text-[10.5px] text-text-tertiary">{label}</p>
      <p className="mt-0.5 text-[12.5px] font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}
