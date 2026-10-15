import * as React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publicApiFetch } from "@/lib/api";
import { supabase } from "@/lib/supabase";

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open(): void };
  }
}

interface PendingPayment {
  razorpaySubscriptionId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}

export default function Signup() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const planId = searchParams.get("plan") ?? "small";

  const [brandName, setBrandName] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [ownerName, setOwnerName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // Set once Razorpay Checkout reports a successful payment. While set, the customer has
  // already been charged, so retries must go straight to /complete — never back through
  // /api/signup + Checkout, which would create a new subscription and charge them again.
  const [pendingPayment, setPendingPayment] = React.useState<PendingPayment | null>(null);

  const completeSignup = async (payment: PendingPayment) => {
    try {
      await publicApiFetch("/api/signup/complete", {
        method: "POST",
        body: JSON.stringify({ ...payment, brandName, category, ownerName, email, password }),
      });
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setPendingPayment(null);
        setError(`Payment succeeded, but automatic sign-in failed: ${signInError.message}. Please log in manually.`);
        return;
      }
      setPendingPayment(null);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong provisioning your account.");
      // Deliberately do NOT clear pendingPayment here — the customer already paid, so
      // the retry button below must stay available rather than forcing them through
      // Razorpay Checkout (and a second charge) again.
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Defensive: the submit button is hidden while a payment is pending, but Enter in a
    // field still submits the form — never start a second checkout for a paid signup.
    if (pendingPayment) return;
    setError(null);
    setSubmitting(true);
    try {
      const signupRes = await publicApiFetch("/api/signup", { method: "POST", body: JSON.stringify({ planId, email }) });
      const { razorpaySubscriptionId, razorpayKeyId } = await signupRes.json();

      const razorpay = new window.Razorpay({
        key: razorpayKeyId,
        subscription_id: razorpaySubscriptionId,
        name: "D2C Analytics Dashboard",
        prefill: { email },
        handler: async (response: { razorpay_payment_id: string; razorpay_subscription_id: string; razorpay_signature: string }) => {
          const payment: PendingPayment = {
            razorpaySubscriptionId: response.razorpay_subscription_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          };
          setPendingPayment(payment);
          await completeSignup(payment);
        },
        modal: { ondismiss: () => setSubmitting(false) },
      });
      razorpay.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong starting checkout.");
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">Create your account</h1>
        <Input placeholder="Brand name" value={brandName} onChange={(e) => setBrandName(e.target.value)} required />
        <Input placeholder="Category (e.g. Fashion & Apparel)" value={category} onChange={(e) => setCategory(e.target.value)} required />
        <Input placeholder="Your name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} required />
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
        {error && (
          <div className="space-y-2">
            <p className="text-[12.5px] text-negative">{error}</p>
            {pendingPayment && (
              <Button
                type="button"
                className="w-full"
                disabled={submitting}
                onClick={() => {
                  setSubmitting(true);
                  setError(null);
                  completeSignup(pendingPayment);
                }}
              >
                {submitting ? "Retrying…" : "Retry account setup"}
              </Button>
            )}
          </div>
        )}
        {!pendingPayment && (
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Processing…" : "Continue to payment"}
          </Button>
        )}
      </form>
    </div>
  );
}
