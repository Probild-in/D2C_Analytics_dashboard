import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ApiError, apiFetch } from "@/lib/api";

interface Candidate {
  id: string;
  label: string;
}

interface PendingInfo {
  platform: string;
  clientId: string | null;
  candidates?: Candidate[];
}

export default function ConnectPickAccounts() {
  const [params] = useSearchParams();
  const pendingId = params.get("pending");
  const navigate = useNavigate();

  const [info, setInfo] = React.useState<PendingInfo | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [selectError, setSelectError] = React.useState<string | null>(null);

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
    if (!pendingId || !selected) return;
    setBusy(true);
    setSelectError(null);
    try {
      await apiFetch(`/api/connections/pending/${pendingId}/select`, {
        method: "POST",
        body: JSON.stringify({ externalAccountId: selected }),
      });
      navigate("/manage-clients?connection=success");
    } catch (err) {
      setSelectError(err instanceof ApiError ? err.message : "Failed to connect. Please try again.");
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
          <CardTitle>Choose an ad account</CardTitle>
          <CardDescription>This Meta login has access to more than one ad account. Pick the one to connect.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 px-5 pb-5">
          {(info.candidates ?? []).map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-md)] border border-border-subtle p-2.5 text-[12.5px] has-[:checked]:border-brand has-[:checked]:bg-brand-subtle"
            >
              <input
                type="radio"
                name="ad-account"
                value={c.id}
                checked={selected === c.id}
                onChange={() => setSelected(c.id)}
              />
              {c.label}
            </label>
          ))}
          {selectError && (
            <p role="alert" className="text-[11px] text-negative">
              {selectError}
            </p>
          )}
          <Button className="w-full" disabled={!selected || busy} onClick={confirm}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
