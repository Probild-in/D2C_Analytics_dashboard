import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError, apiFetch } from "@/lib/api";
import type { PlatformMeta } from "./platforms";

export function CredentialsDialog({
  open,
  onOpenChange,
  platform,
  clientId,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  platform: PlatformMeta;
  clientId: string;
  onConnected: () => void;
}) {
  const fields = platform.fields ?? [];
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const ready = fields.every((f) => (values[f.name] ?? "").trim().length > 0);

  const handleOpenChange = (next: boolean) => {
    if (busy) return;
    if (!next) {
      // Never keep a typed password around after the dialog closes.
      setValues({});
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${clientId}/connections/${platform.key}/connect`, {
        method: "POST",
        body: JSON.stringify({ credentials: values }),
      });
      setValues({});
      onOpenChange(false);
      onConnected();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Failed to connect ${platform.label}. Please try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connect {platform.label}</DialogTitle>
            {platform.helper && <DialogDescription>{platform.helper}</DialogDescription>}
          </DialogHeader>

          <div className="space-y-3 px-5 py-4">
            {fields.map((field) => (
              <label key={field.name} className="block text-[12px] font-medium text-text-secondary">
                {field.label}
                <Input
                  className="mt-1"
                  type={field.type}
                  placeholder={field.placeholder}
                  autoComplete="off"
                  value={values[field.name] ?? ""}
                  onChange={(e) => {
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }));
                    setError(null);
                  }}
                />
              </label>
            ))}
            {error && (
              <p role="alert" className="text-[12px] text-negative">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready || busy}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
