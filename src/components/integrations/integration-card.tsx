import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { CredentialsDialog } from "./credentials-dialog";
import type { Connection, PlatformMeta } from "./platforms";

const STATUS_BADGE = {
  connected: { label: "Connected", variant: "positive" },
  error: { label: "Needs attention", variant: "warning" },
  disconnected: { label: "Not connected", variant: "neutral" },
} as const;

// The panel remounts a card (via `key`) whenever its connection status changes, so `busy`
// intentionally stays true after a successful disconnect until the refetched status arrives:
// there is no window in which a second click could send a second request.
export function IntegrationCard({
  platform,
  connection,
  clientId,
  onChanged,
}: {
  platform: PlatformMeta;
  connection: Connection | undefined;
  clientId: string;
  onChanged: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [credentialsOpen, setCredentialsOpen] = React.useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = React.useState(false);

  const Icon = platform.icon;
  const status = connection?.status ?? "disconnected";
  const badge = STATUS_BADGE[status];
  const isConnected = status === "connected";
  const usesCredentials = platform.authType === "credentials";
  const needsInput = Boolean(platform.input) && !isConnected;
  const canConnect = !busy && (!needsInput || value.trim().length > 0);

  const connect = async () => {
    if (usesCredentials) {
      setCredentialsOpen(true);
      return;
    }
    if (!canConnect) return;
    setBusy(true);
    setError(null);
    try {
      const body = platform.input ? { [platform.input.bodyKey]: value.trim() } : {};
      const res = await apiFetch(`/api/clients/${clientId}/connections/${platform.key}/authorize`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
      // Full-page redirect to the provider's login; the backend callback brings the user back.
      window.location.href = authorizeUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to connect ${platform.label}. Please try again.`);
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setConfirmingDisconnect(false);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${clientId}/connections/${platform.key}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to disconnect ${platform.label}. Please try again.`);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-md)] border border-border-subtle bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-bg-subtle text-text-secondary">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12.5px] font-medium text-text-primary">{platform.label}</p>
            <Badge variant={badge.variant} dot>
              {badge.label}
            </Badge>
          </div>
          <p className="text-[11px] text-text-tertiary">{platform.description}</p>
          {connection && isConnected && (
            <p className="mt-0.5 truncate text-[11px] text-text-secondary">
              {connection.externalAccountId}
              {connection.lastSyncedAt
                ? ` · synced ${new Date(connection.lastSyncedAt).toLocaleString()}`
                : " · first sync pending"}
            </p>
          )}
          {status === "error" && <p className="mt-0.5 text-[11px] text-warning">The last sync failed. Reconnect to fix it.</p>}
        </div>
      </div>

      {needsInput && platform.input && (
        <div>
          <Input
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") connect();
            }}
            placeholder={platform.input.placeholder}
            aria-label={`${platform.label} ${platform.input.placeholder}`}
            aria-describedby={`${platform.key}-input-help`}
            className="h-8 text-[12px]"
          />
          <p id={`${platform.key}-input-help`} className="mt-1 text-[11px] text-text-tertiary">
            {platform.input.helper}
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[11px] text-negative">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        {isConnected ? (
          <Button size="sm" variant="ghost" onClick={() => setConfirmingDisconnect(true)} disabled={busy}>
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={connect} disabled={!canConnect}>
            {status === "error" ? "Reconnect" : "Connect"}
          </Button>
        )}
      </div>

      {usesCredentials && (
        <CredentialsDialog
          open={credentialsOpen}
          onOpenChange={setCredentialsOpen}
          platform={platform}
          clientId={clientId}
          onConnected={onChanged}
        />
      )}

      <Dialog open={confirmingDisconnect} onOpenChange={setConfirmingDisconnect}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {platform.label}?</DialogTitle>
            <DialogDescription>
              Syncing stops and the stored access is deleted. Data already synced is kept.
              {usesCredentials ? " To reconnect you'll need to enter the credentials again." : " You can reconnect at any time."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmingDisconnect(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={disconnect}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
