import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api";
import { useApp } from "@/store/app-context";

interface PendingInfo {
  platform: string;
  clientId: string | null;
  shop?: string;
}

export default function ConnectClaim() {
  const [params] = useSearchParams();
  const pendingId = params.get("pending");
  const navigate = useNavigate();
  const { clients } = useApp();

  const [info, setInfo] = React.useState<PendingInfo | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [claimError, setClaimError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!pendingId) {
      setLoadError("This link expired, please connect again.");
      return;
    }
    let cancelled = false;
    apiFetch(`/api/connections/pending/${pendingId}`)
      .then((res) => res.json())
      .then((body: PendingInfo) => {
        if (!cancelled) setInfo(body);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "This link expired, please connect again.");
      });
    return () => {
      cancelled = true;
    };
  }, [pendingId]);

  const confirm = async () => {
    if (!pendingId || !selectedClientId) return;
    setBusy(true);
    setClaimError(null);
    try {
      await apiFetch(`/api/connections/pending/${pendingId}/claim`, {
        method: "POST",
        body: JSON.stringify({ clientId: selectedClientId }),
      });
      navigate("/manage-clients?connection=success");
    } catch (err) {
      setClaimError(err instanceof ApiError ? err.message : "Failed to connect. Please try again.");
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg p-4">
        <Card className="max-w-sm">
          <CardContent className="p-5 text-center">
            <p className="text-[13px] text-negative">{loadError}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="size-6 animate-spin rounded-full border-2 border-border border-t-brand" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Which client is this?</CardTitle>
          <CardDescription>
            {info.shop ?? "This Shopify store"} just connected. Pick the client it belongs to.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-5">
          {clients.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle p-2.5 text-[12.5px] has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <input
                type="radio"
                name="client"
                value={c.id}
                checked={selectedClientId === c.id}
                onChange={() => setSelectedClientId(c.id)}
              />
              {c.name}
            </label>
          ))}
          {claimError && (
            <p role="alert" className="text-[11px] text-negative">
              {claimError}
            </p>
          )}
          <Button className="w-full" disabled={!selectedClientId || busy} onClick={confirm}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
