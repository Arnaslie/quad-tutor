import { fulfilCheckout } from "./checkout";
import { purchasePackage, purchaseTopUp, type PurchaseResult } from "./purchase";

/** Tests and db:demo only: settles a checkout with made-up payment data, as Stripe's word would. */
export async function pay(result: PurchaseResult): Promise<{ engagementId: string }> {
  const { engagementId } = result;
  if (result.outcome === "paid") return { engagementId };
  if (result.outcome === "expired") throw new Error(`Checkout ${engagementId} expired`);
  const { checkout } = result;

  const fulfilled = await fulfilCheckout({
    engagementId,
    institutionId: checkout.institutionId,
    checkoutSessionId: `cs_test_${engagementId}`,
    payment: {
      paymentIntentId: `pi_test_${engagementId}`,
      amountTotal: checkout.amountMinor,
      currency: checkout.currency,
    },
  });
  if (fulfilled.outcome !== "fulfilled") {
    throw new Error(`Checkout ${engagementId} did not fulfil: ${fulfilled.outcome}`);
  }
  return { engagementId };
}

export async function buyPackage(
  params: Parameters<typeof purchasePackage>[0],
): Promise<{ engagementId: string }> {
  return pay(await purchasePackage(params));
}

export async function buyTopUp(
  params: Parameters<typeof purchaseTopUp>[0],
): Promise<{ engagementId: string }> {
  return pay(await purchaseTopUp(params));
}
