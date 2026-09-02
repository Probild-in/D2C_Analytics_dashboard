import type { Connector } from "./types.js";
import pool from "../db.js";
import { decryptToken } from "../lib/crypto.js";

const META_API_VERSION = "v21.0";
const META_SCOPES = "ads_read";

interface MetaCampaign {
  id: string;
  name: string;
  status: string;
}

interface MetaInsightRow {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  impressions: string;
  clicks: string;
  actions?: { action_type: string; value: string }[];
}

interface MetaAd {
  id: string;
  name: string;
  campaign_id: string;
  status: string;
  created_time: string;
  creative: {
    id: string;
    object_type: string;
    title?: string;
    body?: string;
    call_to_action_type?: string;
    thumbnail_url?: string;
  };
}

// Meta's core statuses (ACTIVE/PAUSED/...) map onto this narrower enum the way Shopify's
// financial_status/fulfillment_status map onto the order-status enum — deliberately lossy,
// not a bug. Anything not recognized falls back to "paused" rather than throwing, since
// Meta's status vocabulary is broader than what this dashboard displays (e.g. ARCHIVED,
// DELETED, WITH_ISSUES all collapse to "paused" — the safest default: not shown as
// actively spending).
function mapCampaignStatus(status: string): string {
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "active";
  if (s === "IN_PROCESS" || s === "PENDING_REVIEW") return "in review";
  if (s === "COMPLETED") return "completed";
  return "paused";
}

// Extracts the purchase count from Meta Insights' `actions` array, which lists every
// action type (link clicks, video views, purchases, ...) the ad drove — we only care
// about purchases for the "results" metric this dashboard shows.
function extractPurchases(actions: { action_type: string; value: string }[] | undefined): number {
  const purchase = actions?.find((a) => a.action_type === "omni_purchase" || a.action_type === "purchase");
  return purchase ? Math.round(parseFloat(purchase.value)) : 0;
}

function getRedirectUri(): string {
  const publicApiUrl = process.env.PUBLIC_API_URL;
  if (!publicApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${publicApiUrl}/api/integrations/meta/callback`;
}

function getCredentials(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID and META_APP_SECRET environment variables must be set");
  }
  return { appId, appSecret };
}

async function assertUnderMetaAccountLimit(clientId: string): Promise<void> {
  const result = await pool.query(
    `select
       coalesce(p.included_meta_accounts, 0) + coalesce(s.extra_meta_accounts, 0) as limit,
       (select count(*) from platform_connections where client_id = $1 and platform = 'meta' and status = 'connected') as current_count
     from subscriptions s
     join plans p on p.id = s.plan_id
     where s.client_id = $1`,
    [clientId],
  );
  if (result.rowCount === 0) {
    // No subscription row at all means no Meta accounts are provisioned for this client.
    throw new Error("This client has no active subscription — cannot connect a Meta account");
  }
  const { limit, current_count: currentCount } = result.rows[0];
  if (Number(currentCount) >= Number(limit)) {
    throw new Error(`Meta account limit reached (${limit} account(s) included on this client's plan)`);
  }
}

export const metaConnector: Connector = {
  platform: "meta",

  getAuthUrl(_clientId: string, state: string): string {
    const { appId } = getCredentials();
    const url = new URL(`https://www.facebook.com/${META_API_VERSION}/dialog/oauth`);
    url.searchParams.set("client_id", appId);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("scope", META_SCOPES);
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>, context: { clientId: string }) {
    const code = query.code;
    if (!code) {
      throw new Error("Meta callback missing code query parameter");
    }
    await assertUnderMetaAccountLimit(context.clientId);

    const { appId, appSecret } = getCredentials();
    const tokenParams = new URLSearchParams({
      client_id: appId,
      redirect_uri: getRedirectUri(),
      client_secret: appSecret,
      code,
    });
    const tokenRes = await fetch(`https://graph.facebook.com/${META_API_VERSION}/oauth/access_token?${tokenParams}`);
    if (!tokenRes.ok) {
      throw new Error(`Meta token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string; expires_in?: number };

    const adAccountsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/me/adaccounts?fields=id,name&access_token=${tokenBody.access_token}`,
    );
    if (!adAccountsRes.ok) {
      throw new Error(`Meta ad accounts fetch failed: ${adAccountsRes.status}`);
    }
    const adAccountsBody = (await adAccountsRes.json()) as { data: { id: string; name: string }[] };
    if (adAccountsBody.data.length === 0) {
      throw new Error("No Meta ad account is accessible with this login — the user must have at least one ad account");
    }

    return {
      externalAccountId: adAccountsBody.data[0].id,
      accessToken: tokenBody.access_token,
      expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined,
    };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, external_account_id from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);
    const adAccountId = conn.external_account_id;

    const campaignsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/campaigns?fields=id,name,status&access_token=${accessToken}`,
    );
    if (!campaignsRes.ok) {
      throw new Error(`Meta campaigns fetch failed: ${campaignsRes.status}`);
    }
    const campaignsBody = (await campaignsRes.json()) as { data: MetaCampaign[] };

    let recordsSynced = 0;
    for (const campaign of campaignsBody.data) {
      const campaignRow = await pool.query(
        `insert into campaigns (client_id, connection_id, external_campaign_id, name, status)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, external_campaign_id)
         do update set name = excluded.name, status = excluded.status
         returning id`,
        [conn.client_id, connectionId, campaign.id, campaign.name, mapCampaignStatus(campaign.status)],
      );
      const campaignRowId = campaignRow.rows[0].id;
      recordsSynced++;

      const insightsRes = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${campaign.id}/insights?fields=campaign_id,campaign_name,spend,impressions,clicks,actions&access_token=${accessToken}`,
      );
      if (!insightsRes.ok) {
        throw new Error(`Meta insights fetch failed for campaign ${campaign.id}: ${insightsRes.status}`);
      }
      const insightsBody = (await insightsRes.json()) as { data: MetaInsightRow[] };
      for (const row of insightsBody.data) {
        await pool.query(
          `insert into meta_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, results)
           values ($1, $2, $3, $4, current_date, $5, $6, $7, $8)
           on conflict (connection_id, campaign_id, metric_date)
           do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            conn.client_id,
            connectionId,
            row.campaign_id,
            row.campaign_name,
            Math.round(parseFloat(row.spend)),
            Math.round(parseFloat(row.impressions)),
            Math.round(parseFloat(row.clicks)),
            extractPurchases(row.actions),
          ],
        );
      }

      const adsRes = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${campaign.id}/ads?fields=id,name,campaign_id,status,created_time,creative{id,object_type,title,body,call_to_action_type,thumbnail_url}&access_token=${accessToken}`,
      );
      if (!adsRes.ok) {
        throw new Error(`Meta ads fetch failed for campaign ${campaign.id}: ${adsRes.status}`);
      }
      const adsBody = (await adsRes.json()) as { data: MetaAd[] };
      for (const ad of adsBody.data) {
        const adInsightsRes = await fetch(
          `https://graph.facebook.com/${META_API_VERSION}/${ad.id}/insights?fields=spend,impressions,clicks,actions&access_token=${accessToken}`,
        );
        if (!adInsightsRes.ok) {
          throw new Error(`Meta ad insights fetch failed for ad ${ad.id}: ${adInsightsRes.status}`);
        }
        const adInsightsBody = (await adInsightsRes.json()) as { data: MetaInsightRow[] };
        const adMetrics = adInsightsBody.data[0];

        await pool.query(
          `insert into campaign_creatives
             (campaign_id, external_creative_id, name, format, headline, primary_text, cta, thumbnail_url, status, spend, impressions, clicks, results, launched_date)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           on conflict (campaign_id, external_creative_id)
           do update set name = excluded.name, status = excluded.status, spend = excluded.spend,
             impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            campaignRowId,
            ad.creative.id,
            ad.name,
            ad.creative.object_type,
            ad.creative.title ?? null,
            ad.creative.body ?? null,
            ad.creative.call_to_action_type ?? null,
            ad.creative.thumbnail_url ?? null,
            mapCampaignStatus(ad.status),
            adMetrics ? Math.round(parseFloat(adMetrics.spend)) : 0,
            adMetrics ? Math.round(parseFloat(adMetrics.impressions)) : 0,
            adMetrics ? Math.round(parseFloat(adMetrics.clicks)) : 0,
            adMetrics ? extractPurchases(adMetrics.actions) : 0,
            ad.created_time.slice(0, 10),
          ],
        );
      }
    }

    await pool.query("update platform_connections set last_synced_at = now(), status = 'connected' where id = $1", [connectionId]);
    return { recordsSynced };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
