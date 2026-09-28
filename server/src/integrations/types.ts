// Thrown by a credentials connector when the provider says the credentials are wrong.
// The message is shown to the end user, so keep it human-readable and free of secrets.
export class CredentialsRejectedError extends Error {}

// handleCallback's result: either the OAuth login resolved to exactly one account and is
// ready to save, or it granted several and the user needs to pick one (Meta's ad-account
// picker) or the account owning it isn't known yet (Shopify's install-link claim, plan 5).
export type OAuthCallbackResult =
  | {
      type: "connected";
      externalAccountId: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: Date;
    }
  | {
      type: "pending";
      accessToken: string;
      expiresAt?: Date;
      candidates: { id: string; label: string }[];
    };

interface BaseConnector {
  platform: string;
  sync(connectionId: string): Promise<{ recordsSynced: number }>;
  disconnect(connectionId: string): Promise<void>;
}

// Connects by redirecting the user to the provider and handling the callback.
export interface OAuthConnector extends BaseConnector {
  authType: "oauth";
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query: Record<string, string>, context: { clientId: string | undefined }): Promise<OAuthCallbackResult>;
}

// Connects from a form: the connector validates the credentials live against the provider.
export interface CredentialsConnector extends BaseConnector {
  authType: "credentials";
  connectWithCredentials(
    clientId: string,
    credentials: Record<string, string>,
  ): Promise<{
    externalAccountId: string;
    accessToken: string;
    expiresAt?: Date;
    // Secrets the connector needs later (e.g. Shiprocket email + password for re-login).
    // The route stores them encrypted in platform_connections.credentials.
    credentials?: Record<string, string>;
  }>;
}

export type Connector = OAuthConnector | CredentialsConnector;
