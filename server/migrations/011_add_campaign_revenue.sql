-- Campaign-level ROAS was hardcoded to 0 in server/src/routes/campaigns.ts — neither sync
-- connector ever fetched or stored the purchase/conversion revenue needed to compute it,
-- only the purchase/conversion *count*. Adds the missing revenue column everywhere spend
-- is already tracked, so ROAS can finally be computed as revenue / spend instead of faked.
alter table meta_campaign_metrics add column revenue integer not null default 0;
alter table google_campaign_metrics add column revenue integer not null default 0;
alter table campaign_creatives add column revenue integer not null default 0;
