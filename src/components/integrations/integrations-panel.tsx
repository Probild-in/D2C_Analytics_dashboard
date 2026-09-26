import * as React from "react";
import { useClientResource } from "@/hooks/use-client-resource";
import { IntegrationCard, pickConnection } from "./integration-card";
import { OAUTH_PLATFORMS, type Connection } from "./platforms";

const EMPTY_CONNECTIONS: Connection[] = [];

export function IntegrationsPanel({ clientId }: { clientId: string }) {
  // useClientResource refetches when its path changes; bumping this throwaway query param
  // after a disconnect forces a reload (the server ignores unknown query params).
  const [version, setVersion] = React.useState(0);
  const { data: connections, loading } = useClientResource<Connection[]>(
    `/api/clients/${clientId}/connections?v=${version}`,
    EMPTY_CONNECTIONS,
  );

  if (loading && connections.length === 0) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  return (
    <div className="space-y-2">
      {OAUTH_PLATFORMS.map((platform) => (
        <IntegrationCard
          key={platform.key}
          platform={platform}
          connection={pickConnection(connections, platform.key)}
          clientId={clientId}
          onChanged={() => setVersion((v) => v + 1)}
        />
      ))}
    </div>
  );
}
