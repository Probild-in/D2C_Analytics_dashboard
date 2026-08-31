export interface Connector {
  platform: string;
  getAuthUrl(clientId: string, state: string): string;
  handleCallback(query: Record<string, string>): Promise<{
    externalAccountId: string;
    accessToken: string;
    refreshToken?: string;
    expiresAt?: Date;
  }>;
  sync(connectionId: string): Promise<{ recordsSynced: number }>;
  disconnect(connectionId: string): Promise<void>;
}
