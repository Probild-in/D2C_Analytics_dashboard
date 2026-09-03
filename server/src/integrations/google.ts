import type { Connector } from "./types.js";
import pool from "../db.js";
import { decryptToken, encryptToken } from "../lib/crypto.js";

const GOOGLE_ADS_API_VERSION = "v25";
const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/adwords";

function getRedirectUri(): string {
  const publicApiUrl = process.env.PUBLIC_API_URL;
  if (!publicApiUrl) {
    throw new Error("PUBLIC_API_URL environment variable must be set");
  }
  return `${publicApiUrl}/api/integrations/google/callback`;
}

function getOAuthCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET environment variables must be set");
  }
  return { clientId, clientSecret };
}

function getDeveloperToken(): string {
  const token = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!token) {
    throw new Error("GOOGLE_ADS_DEVELOPER_TOKEN environment variable must be set");
  }
  return token;
}

async function assertUnderGoogleAccountLimit(clientId: string): Promise<void> {
  const result = await pool.query(
    `select
       coalesce(p.included_google_accounts, 0) + coalesce(s.extra_google_accounts, 0) as limit,
       (select count(*) from platform_connections where client_id = $1 and platform = 'google' and status = 'connected') as current_count
     from subscriptions s
     join plans p on p.id = s.plan_id
     where s.client_id = $1`,
    [clientId],
  );
  if (result.rowCount === 0) {
    throw new Error("This client has no active subscription — cannot connect a Google account");
  }
  const { limit, current_count: currentCount } = result.rows[0];
  if (Number(currentCount) >= Number(limit)) {
    throw new Error(`Google account limit reached (${limit} account(s) included on this client's plan)`);
  }
}

interface GoogleCampaignRow {
  campaign: { id: string; name: string; status: string };
}

interface GoogleMetricsRow {
  campaign: { id: string; name: string };
  metrics: { impressions: string; clicks: string; costMicros: string; conversions: string };
}

interface GoogleAdRow {
  adGroupAd: {
    ad: {
      id: string;
      name: string;
      responsiveSearchAd?: { headlines: { text: string }[]; descriptions: { text: string }[] };
    };
    status: string;
  };
  campaign: { id: string };
  metrics: { impressions: string; clicks: string; costMicros: string; conversions: string };
}

// Google's status vocabulary (ENABLED/PAUSED/REMOVED/...) maps onto this dashboard's
// narrower enum the same deliberately-lossy way Shopify's and Meta's connectors do.
function mapGoogleStatus(status: string): string {
  const s = status.toUpperCase();
  if (s === "ENABLED") return "active";
  if (s === "PAUSED") return "paused";
  return "paused";
}

function microsToUnits(micros: string): number {
  return Math.round(parseFloat(micros) / 1_000_000);
}

async function refreshAccessToken(connectionId: string, refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getOAuthCredentials();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  await pool.query(
    "update platform_connections set access_token = $2, token_expires_at = $3 where id = $1",
    [connectionId, encryptToken(body.access_token), body.expires_in ? new Date(Date.now() + body.expires_in * 1000) : null],
  );
  return body.access_token;
}

// Wraps a single Google Ads API call with lazy refresh-on-401: tries the request with the
// current access token; if Google returns 401 (the token expired — these are short-lived,
// ~1 hour), refreshes once via the stored refresh_token and retries exactly once more. A
// 401 after the retry means the refresh_token itself is no longer valid (e.g. revoked) and
// is allowed to propagate as a real failure, same as any other sync error.
async function withTokenRefresh<T>(
  connectionId: string,
  accessToken: string,
  refreshToken: string,
  makeRequest: (token: string) => Promise<Response>,
  parseResponse: (res: Response) => Promise<T>,
): Promise<T> {
  let res = await makeRequest(accessToken);
  if (res.status === 401) {
    const freshToken = await refreshAccessToken(connectionId, refreshToken);
    res = await makeRequest(freshToken);
  }
  if (!res.ok) {
    throw new Error(`Google Ads API request failed: ${res.status}`);
  }
  return parseResponse(res);
}

async function runGaqlQuery<T>(
  connectionId: string,
  accessToken: string,
  refreshToken: string,
  customerId: string,
  query: string,
): Promise<T[]> {
  const body = await withTokenRefresh(
    connectionId,
    accessToken,
    refreshToken,
    (token) =>
      fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "developer-token": getDeveloperToken(),
          "login-customer-id": customerId,
        },
        body: JSON.stringify({ query }),
      }),
    (res) => res.json(),
  );
  // searchStream returns an array of response "batches", each with its own `results` array
  // — flatten them into one list of rows, matching how this codebase treats every other
  // connector's response as a flat list to iterate.
  return (body as { results?: T[] }[]).flatMap((batch) => batch.results ?? []);
}

export const googleConnector: Connector = {
  platform: "google",

  getAuthUrl(_clientId: string, state: string): string {
    const { clientId } = getOAuthCredentials();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", getRedirectUri());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
    // access_type=offline + prompt=consent together are required to get a refresh_token
    // back — Google only issues one on a user's FIRST consent unless prompt=consent
    // forces the consent screen (and a fresh refresh_token) every time. Without both,
    // a user who previously authorized this app for an unrelated reason would silently
    // get no refresh_token at all, and this connector has no way to function without one.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async handleCallback(query: Record<string, string>, context: { clientId: string }) {
    const code = query.code;
    if (!code) {
      throw new Error("Google callback missing code query parameter");
    }
    await assertUnderGoogleAccountLimit(context.clientId);

    const { clientId, clientSecret } = getOAuthCredentials();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getRedirectUri(),
      }),
    });
    if (!tokenRes.ok) {
      throw new Error(`Google token exchange failed: ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    if (!tokenBody.refresh_token) {
      throw new Error("Google did not return a refresh token — try disconnecting this app's access at myaccount.google.com/permissions and reconnecting");
    }

    const customersRes = await fetch(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers:listAccessibleCustomers`, {
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "developer-token": getDeveloperToken(),
      },
    });
    if (!customersRes.ok) {
      throw new Error(`Google listAccessibleCustomers failed: ${customersRes.status}`);
    }
    const customersBody = (await customersRes.json()) as { resourceNames: string[] };
    if (customersBody.resourceNames.length === 0) {
      throw new Error("No Google Ads customer account is accessible with this login");
    }
    // "customers/1234567890" -> "1234567890". Simplified to the first accessible
    // customer for both the connection's external_account_id and its own
    // login-customer-id — see this plan's Global Constraints for why full MCC
    // hierarchy traversal is deliberately out of scope here.
    const externalAccountId = customersBody.resourceNames[0].split("/")[1];

    return {
      externalAccountId,
      accessToken: tokenBody.access_token,
      refreshToken: tokenBody.refresh_token,
      expiresAt: tokenBody.expires_in ? new Date(Date.now() + tokenBody.expires_in * 1000) : undefined,
    };
  },

  async sync(connectionId: string) {
    const connResult = await pool.query(
      "select client_id, access_token, refresh_token, external_account_id from platform_connections where id = $1",
      [connectionId],
    );
    if (connResult.rowCount === 0) {
      throw new Error(`No connection found for id ${connectionId}`);
    }
    const conn = connResult.rows[0];
    const accessToken = decryptToken(conn.access_token);
    const refreshToken = decryptToken(conn.refresh_token);
    const customerId = conn.external_account_id;

    const campaignRows = await runGaqlQuery<GoogleCampaignRow>(
      connectionId,
      accessToken,
      refreshToken,
      customerId,
      "SELECT campaign.id, campaign.name, campaign.status FROM campaign",
    );

    let recordsSynced = 0;
    for (const row of campaignRows) {
      const campaignRow = await pool.query(
        `insert into campaigns (client_id, connection_id, external_campaign_id, name, status)
         values ($1, $2, $3, $4, $5)
         on conflict (connection_id, external_campaign_id)
         do update set name = excluded.name, status = excluded.status
         returning id`,
        [conn.client_id, connectionId, row.campaign.id, row.campaign.name, mapGoogleStatus(row.campaign.status)],
      );
      const campaignRowId = campaignRow.rows[0].id;
      recordsSynced++;

      const metricsRows = await runGaqlQuery<GoogleMetricsRow>(
        connectionId,
        accessToken,
        refreshToken,
        customerId,
        `SELECT campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.id = ${row.campaign.id} AND segments.date DURING TODAY`,
      );
      for (const m of metricsRows) {
        await pool.query(
          `insert into google_campaign_metrics (client_id, connection_id, campaign_id, campaign_name, metric_date, spend, impressions, clicks, conversions)
           values ($1, $2, $3, $4, current_date, $5, $6, $7, $8)
           on conflict (connection_id, campaign_id, metric_date)
           do update set spend = excluded.spend, impressions = excluded.impressions, clicks = excluded.clicks, conversions = excluded.conversions`,
          [
            conn.client_id,
            connectionId,
            m.campaign.id,
            m.campaign.name,
            microsToUnits(m.metrics.costMicros),
            Math.round(parseFloat(m.metrics.impressions)),
            Math.round(parseFloat(m.metrics.clicks)),
            Math.round(parseFloat(m.metrics.conversions)),
          ],
        );
      }

      const adRows = await runGaqlQuery<GoogleAdRow>(
        connectionId,
        accessToken,
        refreshToken,
        customerId,
        `SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.status, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM ad_group_ad WHERE campaign.id = ${row.campaign.id} AND segments.date DURING TODAY`,
      );
      for (const adRow of adRows) {
        const rsa = adRow.adGroupAd.ad.responsiveSearchAd;
        await pool.query(
          `insert into campaign_creatives
             (campaign_id, external_creative_id, name, format, headline, primary_text, cta, thumbnail_url, status, spend, impressions, clicks, results)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           on conflict (campaign_id, external_creative_id)
           do update set name = excluded.name, status = excluded.status, spend = excluded.spend,
             impressions = excluded.impressions, clicks = excluded.clicks, results = excluded.results`,
          [
            campaignRowId,
            adRow.adGroupAd.ad.id,
            adRow.adGroupAd.ad.name,
            "RESPONSIVE_SEARCH_AD",
            rsa?.headlines[0]?.text ?? null,
            rsa?.descriptions[0]?.text ?? null,
            null, // Google Search ads have no single "call to action" field the way Meta's do
            null, // no visual asset for a text-only search ad
            mapGoogleStatus(adRow.adGroupAd.status),
            microsToUnits(adRow.metrics.costMicros),
            Math.round(parseFloat(adRow.metrics.impressions)),
            Math.round(parseFloat(adRow.metrics.clicks)),
            Math.round(parseFloat(adRow.metrics.conversions)),
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
