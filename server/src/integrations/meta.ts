import type { Connector } from "./types.js";
import pool from "../db.js";

const META_API_VERSION = "v21.0";
const META_SCOPES = "ads_read";

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

  async sync(_connectionId: string) {
    // Implemented in Task 4.
    return { recordsSynced: 0 };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
