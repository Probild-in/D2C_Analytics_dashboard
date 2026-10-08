import * as React from "react";
import { Button } from "@/components/ui/button";
import { useClientResource } from "@/hooks/use-client-resource";
import { IntegrationCard } from "./integration-card";
import { PLATFORMS, pickConnection, type Connection } from "./platforms";

const EMPTY_CONNECTIONS: Connection[] = [];

export function IntegrationsPanel({ clientId }: { clientId: string }) {
  // useClientResource refetches when its path changes; bumping this throwaway query param
  // after a connect/disconnect forces a reload (the server ignores unknown query params).
  const [version, setVersion] = React.useState(0);
  const {
    data: connections,
    loading,
    error,
  } = useClientResource<Connection[]>(`/api/clients/${clientId}/connections?v=${version}`, EMPTY_CONNECTIONS);

  if (loading && connections.length === 0) {
    return <p className="text-[11px] text-text-tertiary">Loading…</p>;
  }

  // A failed load must not look like "nothing is connected".
  if (error) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-[var(--radius-md)] border border-border-subtle p-3">
        <p role="alert" className="text-[12px] text-negative">
          Couldn't load this client's integrations.
        </p>
        <Button size="sm" variant="secondary" onClick={() => setVersion((v) => v + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {PLATFORMS.map((platform) => {
        const connection = pickConnection(connections, platform.key);
        return (
          <IntegrationCard
            // Remount when the status changes so per-card state (busy, typed input) resets
            // to match the freshly fetched connection.
            key={`${platform.key}:${connection?.status ?? "none"}`}
            platform={platform}
            connection={connection}
            clientId={clientId}
            onChanged={() => setVersion((v) => v + 1)}
          />
        );
      })}
    </div>
  );
}
