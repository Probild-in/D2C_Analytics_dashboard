import { createSubscription } from "./razorpay-api.js";

export interface PaymentGateway {
  createSubscription(clientId: string, planId: string): Promise<{ gatewayCustomerId: string | null }>;
  chargeInvoice(invoiceId: string): Promise<{ status: "paid" | "failed" }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export const stubPaymentGateway: PaymentGateway = {
  async createSubscription(clientId, planId) {
    console.log(`[stub payment gateway] would create subscription for ${clientId} on plan ${planId}`);
    return { gatewayCustomerId: null };
  },
  async chargeInvoice(invoiceId) {
    console.log(`[stub payment gateway] would charge invoice ${invoiceId} — leaving as pending`);
    return { status: "failed" };
  },
  async cancelSubscription(subscriptionId) {
    console.log(`[stub payment gateway] would cancel subscription ${subscriptionId}`);
  },
};

export const razorpayGateway: PaymentGateway = {
  async createSubscription(_clientId, planId) {
    if (planId !== "small" && planId !== "medium" && planId !== "large") {
      throw new Error(`No Razorpay Plan is configured for plan id "${planId}" — only small/medium/large have one`);
    }
    const { id } = await createSubscription(planId as "small" | "medium" | "large");
    return { gatewayCustomerId: id };
  },
  async chargeInvoice(_invoiceId) {
    // Razorpay charges recurring invoices itself on its own billing cycle — this app
    // never initiates a charge directly, it only reacts to the subscription.charged
    // webhook (Task 10). Nothing to do here; kept to satisfy the PaymentGateway interface.
    return { status: "paid" };
  },
  async cancelSubscription(_subscriptionId) {
    // Not needed for this plan's scope (plan changes/cancellation are explicitly out of
    // scope per the spec) — left unimplemented rather than guessed at.
    throw new Error("razorpayGateway.cancelSubscription is not implemented yet");
  },
};
