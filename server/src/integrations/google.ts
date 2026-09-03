import type { Connector } from "./types.js";
import pool from "../db.js";

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

  async sync(_connectionId: string) {
    // Implemented in Task 4.
    return { recordsSynced: 0 };
  },

  async disconnect(connectionId: string) {
    await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
  },
};
