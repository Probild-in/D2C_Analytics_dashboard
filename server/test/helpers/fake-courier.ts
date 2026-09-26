import pool from "../../src/db.js";
import { connectors } from "../../src/lib/connector-registry.js";
import type { CredentialsConnector } from "../../src/integrations/types.js";

export const FAKE_COURIER_PLATFORM = "courier_shiprocket";

// Registers a fake credentials-type connector under a platform key that the DB check
// constraint allows, and returns a function that restores the registry. Use in
// beforeEach/afterEach so tests never leak a fake into each other.
export function installFakeCourier(overrides: Partial<CredentialsConnector> = {}): () => void {
  const original = connectors[FAKE_COURIER_PLATFORM];
  const fake: CredentialsConnector = {
    platform: FAKE_COURIER_PLATFORM,
    authType: "credentials",
    async connectWithCredentials(_clientId, credentials) {
      return { externalAccountId: credentials.email, accessToken: "fake-token", credentials };
    },
    async sync() {
      return { recordsSynced: 0 };
    },
    async disconnect(connectionId) {
      await pool.query("update platform_connections set status = 'disconnected' where id = $1", [connectionId]);
    },
    ...overrides,
  };
  connectors[FAKE_COURIER_PLATFORM] = fake;
  return () => {
    if (original) connectors[FAKE_COURIER_PLATFORM] = original;
    else delete connectors[FAKE_COURIER_PLATFORM];
  };
}
