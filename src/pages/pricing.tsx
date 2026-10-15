import * as React from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { publicApiFetch } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  orderLimit: number | null;
  monthlyFeeInr: number;
  includedMetaAccounts: number | null;
  includedGoogleAccounts: number | null;
  extraMetaAccountPriceInr: number;
  extraGoogleAccountPriceInr: number;
  extraShopifyStorePriceInr: number;
}

export default function Pricing() {
  const navigate = useNavigate();
  const [plans, setPlans] = React.useState<Plan[]>([]);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    publicApiFetch("/api/plans")
      .then((res) => res.json())
      .then(setPlans)
      .catch((err) => setError(err.message));
  }, []);

  const addonPrices = plans[0];

  return (
    <div className="min-h-screen bg-bg p-8">
      <h1 className="mb-6 text-2xl font-semibold text-text-primary">Pricing</h1>
      {error && <p className="text-negative">{error}</p>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-[var(--radius-lg)] border border-border bg-surface p-6">
            <h2 className="text-lg font-semibold text-text-primary">{plan.name}</h2>
            <p className="mt-1 text-sm text-text-secondary">{plan.orderLimit ? `Up to ${plan.orderLimit} orders/month` : "5,000+ orders/month"}</p>
            <p className="mt-4 text-2xl font-bold text-text-primary">
              {plan.id === "enterprise" ? `From ₹${plan.monthlyFeeInr.toLocaleString("en-IN")}` : `₹${plan.monthlyFeeInr.toLocaleString("en-IN")}`}
              <span className="text-sm font-normal text-text-secondary"> /brand/month</span>
            </p>
            <p className="mt-2 text-sm text-text-secondary">
              {plan.includedMetaAccounts ? `${plan.includedMetaAccounts} Meta + ${plan.includedGoogleAccounts} Google` : "Custom ad accounts"}
            </p>
            <Button
              className="mt-6 w-full"
              onClick={() => (plan.id === "enterprise" ? navigate("/contact-enterprise") : navigate(`/signup?plan=${plan.id}`))}
            >
              {plan.id === "enterprise" ? "Contact Us" : "Get Started"}
            </Button>
          </div>
        ))}
      </div>
      {addonPrices && (
        <div className="mt-8 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
          <h2 className="text-lg font-semibold text-text-primary">Add-ons</h2>
          <ul className="mt-2 space-y-1 text-sm text-text-secondary">
            <li>Extra Meta Ad Account — ₹{addonPrices.extraMetaAccountPriceInr}/month</li>
            <li>Extra Google Ads Account — ₹{addonPrices.extraGoogleAccountPriceInr}/month</li>
            <li>Extra Shopify Store (same brand) — ₹{addonPrices.extraShopifyStorePriceInr}/month</li>
          </ul>
        </div>
      )}
    </div>
  );
}
