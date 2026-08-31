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
