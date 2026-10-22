import * as React from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { publicApiFetch, ApiError } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  orderLimit: number | null;
  priceUsd: number;
}

export default function ShopifyAppPlans() {
  const [params] = useSearchParams();
  const clientId = params.get("client");
  const token = params.get("token");
  const declined = params.get("billing") === "declined";
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [error, setError] = React.useState<string | null>(declined ? "Payment was not approved. Pick a plan to try again." : null);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    publicApiFetch("/api/shopify-app/plans")
      .then((res) => res.json())
      .then((data: Plan[]) => setPlans(data))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load plans."));
  }, []);

  const choose = async (planId: string) => {
    if (!clientId || !token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await publicApiFetch(`/api/shopify-app/${clientId}/subscribe`, { method: "POST", body: JSON.stringify({ planId, token }) });
      const { confirmationUrl } = await res.json();
      window.location.href = confirmationUrl;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong starting checkout.");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg p-8">
      <h1 className="mb-2 text-2xl font-semibold text-text-primary">Choose a plan</h1>
      <p className="mb-6 text-sm text-text-secondary">Your store is connected — pick a plan to finish setup.</p>
      {error && <p className="mb-4 text-[13px] text-negative">{error}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-[var(--radius-lg)] border border-border bg-surface p-6">
            <h2 className="text-lg font-semibold text-text-primary">{plan.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">{plan.orderLimit ? `Up to ${plan.orderLimit} orders/month` : "Custom"}</p>
            <p className="mt-4 text-2xl font-bold text-text-primary">${plan.priceUsd}<span className="text-sm font-normal text-text-secondary"> /month</span></p>
            <Button className="mt-6 w-full" disabled={busy} onClick={() => choose(plan.id)}>
              {busy ? "Starting…" : "Select"}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
