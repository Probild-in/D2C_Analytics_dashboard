import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { publicApiFetch } from "@/lib/api";

export default function ContactEnterprise() {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [company, setCompany] = React.useState("");
  const [estimatedOrdersPerMonth, setEstimatedOrdersPerMonth] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitted, setSubmitted] = React.useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await publicApiFetch("/api/enterprise-leads", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          company,
          estimatedOrdersPerMonth: estimatedOrdersPerMonth ? Number(estimatedOrdersPerMonth) : undefined,
          message: message || undefined,
        }),
      });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong submitting this.");
    }
  };

  if (submitted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <p className="text-text-primary">Thanks — we'll be in touch shortly.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 rounded-[var(--radius-lg)] border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold text-text-primary">Enterprise — Contact Us</h1>
        <Input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input placeholder="Company" value={company} onChange={(e) => setCompany(e.target.value)} required />
        <Input type="number" placeholder="Estimated orders/month (optional)" value={estimatedOrdersPerMonth} onChange={(e) => setEstimatedOrdersPerMonth(e.target.value)} />
        <Input placeholder="Anything else? (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        {error && <p className="text-[12.5px] text-negative">{error}</p>}
        <Button type="submit" className="w-full">Submit</Button>
      </form>
    </div>
  );
}
