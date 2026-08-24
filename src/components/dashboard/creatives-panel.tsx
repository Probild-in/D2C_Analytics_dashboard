import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { getCreatives } from "@/data/mock";
import type { Campaign, Creative } from "@/data/types";
import { cn, formatCurrency, formatCurrencyCompact, formatNumber, formatPercent } from "@/lib/utils";
import { GalleryHorizontal, Image as ImageIcon, Play, Video } from "lucide-react";

const FORMAT_ICON: Record<Creative["format"], React.ElementType> = {
  Image: ImageIcon,
  Video: Video,
  Carousel: GalleryHorizontal,
};

// Bundled locally (public/creatives) so they always load — no dependency on
// reaching an external image host, which isn't guaranteed for every viewer/tunnel.
const DEMO_IMAGE_COUNT = 12;
const DEMO_IMAGE_START = 11;

function creativeImageUrl(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const n = DEMO_IMAGE_START + (hash % DEMO_IMAGE_COUNT);
  return `/creatives/demo-${n}.jpg`;
}

function CreativeThumbnail({ creative, size }: { creative: Creative; size: "sm" | "lg" }) {
  const [failed, setFailed] = React.useState(false);

  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden", size === "sm" ? "aspect-video" : "aspect-[2.2/1]", creative.thumbnailColor)}>
      {!failed && (
        <img
          src={creativeImageUrl(creative.id)}
          alt={creative.headline}
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {failed && React.createElement(FORMAT_ICON[creative.format], { className: cn("relative text-white/90", size === "sm" ? "size-6" : "size-8") })}
      {creative.format === "Video" && !failed && (
        <span className="relative flex size-9 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
          <Play className="size-4 fill-white text-white" />
        </span>
      )}
      {creative.format === "Carousel" && !failed && (
        <span className="absolute bottom-1.5 left-1/2 flex -translate-x-1/2 gap-1">
          <span className="size-1 rounded-full bg-white" />
          <span className="size-1 rounded-full bg-white/50" />
          <span className="size-1 rounded-full bg-white/50" />
        </span>
      )}
    </div>
  );
}

export function CreativesGrid({ campaign }: { campaign: Campaign }) {
  const creatives = React.useMemo(() => getCreatives(campaign), [campaign]);
  const [selected, setSelected] = React.useState<Creative | null>(null);

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        {creatives.map((c) => {
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c)}
              className="group flex flex-col overflow-hidden rounded-[var(--radius-md)] border border-border-subtle text-left transition-colors hover:border-brand/40"
            >
              <div className="relative">
                <CreativeThumbnail creative={c} size="sm" />
                <span className="absolute left-1.5 top-1.5 rounded bg-black/40 px-1.5 py-0.5 text-[9.5px] font-medium text-white">{c.format}</span>
                <span className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full ring-2 ring-black/30", c.status === "Active" ? "bg-positive" : "bg-text-tertiary")} />
              </div>
              <div className="space-y-1 bg-bg-subtle/40 p-2">
                <p className="truncate text-[11.5px] font-medium text-text-primary">{c.headline}</p>
                <div className="flex items-center justify-between text-[10.5px] text-text-tertiary">
                  <span>{formatCurrencyCompact(c.spend)} spend</span>
                  <span className={cn("font-semibold", c.roas < 2.5 ? "text-negative" : "text-positive")}>{c.roas.toFixed(2)}x</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <CreativeDetailDialog creative={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </>
  );
}

function CreativeDetailDialog({ creative, onOpenChange }: { creative: Creative | null; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={!!creative} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {creative && (
          <>
            <DialogHeader className="pb-2">
              <div className="flex items-center gap-2 pr-6">
                <Badge variant={creative.status === "Active" ? "positive" : "neutral"} dot>
                  {creative.status}
                </Badge>
                <Badge variant="outline">{creative.format}</Badge>
              </div>
              <DialogTitle className="mt-1">{creative.headline}</DialogTitle>
              <DialogDescription>{creative.name}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 px-5 pb-5">
              <div className="overflow-hidden rounded-[var(--radius-md)]">
                <CreativeThumbnail creative={creative} size="lg" />
              </div>

              <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-3">
                <p className="text-[12.5px] leading-snug text-text-secondary">{creative.primaryText}</p>
                <p className="mt-2 text-[11px] font-semibold text-brand">{creative.cta} →</p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <Tile label="Spend" value={formatCurrencyCompact(creative.spend)} />
                <Tile label="Impressions" value={formatNumber(creative.impressions)} />
                <Tile label="Clicks" value={formatNumber(creative.clicks)} />
                <Tile label="CTR" value={`${creative.ctr}%`} />
                <Tile label="CPC" value={formatCurrency(creative.cpc)} />
                <Tile label="Results" value={formatNumber(creative.results)} />
                <Tile label="ROAS" value={`${creative.roas.toFixed(2)}x`} tone={creative.roas < 2.5 ? "negative" : "positive"} />
                {creative.hookRate !== undefined && <Tile label="Hook rate" value={formatPercent(creative.hookRate)} />}
                {creative.holdRate !== undefined && <Tile label="Hold rate" value={formatPercent(creative.holdRate)} />}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "negative" | "positive" }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border-subtle bg-bg-subtle/40 p-2.5 text-center">
      <p className="text-[10.5px] text-text-tertiary">{label}</p>
      <p
        className={cn(
          "mt-0.5 text-[13px] font-semibold tabular-nums",
          tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-text-primary",
        )}
      >
        {value}
      </p>
    </div>
  );
}
