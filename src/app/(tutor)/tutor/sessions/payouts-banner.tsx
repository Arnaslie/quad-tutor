import { ButtonLink } from "@/components/button";
import { Card } from "@/components/card";
import { Icon } from "@/components/icons";
import { formatMinor } from "@/server/modules/billing/pricing";
import type { PayoutStage } from "@/server/modules/billing/kyc";

import { PAYOUTS_HREF, PAYOUTS_SUPPORT, STAGE_ICON } from "../payouts/stage";

type Banner = { heading: string; body: string; action: string | null };

const owing = (owed: string | null) => (owed ? ` You're owed ${owed}, held for you.` : "");

const BANNERS: Record<PayoutStage, (owed: string | null) => Banner | null> = {
  not_started: (owed) =>
    owed
      ? { heading: `You're owed ${owed}`, body: "Finish setting up payouts to receive it.", action: "Set up payouts" }
      : null,
  pending: (owed) =>
    owed
      ? {
          heading: `${owed} is held for you`,
          body: "Stripe is checking your details. It goes to your bank once they finish.",
          action: null,
        }
      : null,
  restricted: (owed) => ({
    heading: "Stripe needs more from you",
    body: `Update your details so Stripe can send your pay.${owing(owed)}`,
    action: "Update your details",
  }),
  needs_support: (owed) => ({
    heading: "Payouts are blocked on this account",
    body: `${PAYOUTS_SUPPORT}${owing(owed)}`,
    action: null,
  }),
  verified: () => null,
};

export function PayoutsBanner({
  stage,
  owedMinor,
  currency,
}: {
  stage: PayoutStage;
  owedMinor: number;
  currency: string;
}) {
  const banner = BANNERS[stage](owedMinor > 0 ? formatMinor(owedMinor, currency) : null);
  if (!banner) return null;
  const icon = STAGE_ICON[stage];

  return (
    <Card className="flex flex-col items-start gap-3">
      <div className="flex gap-3">
        <Icon name={icon.name} className={`mt-0.5 size-[18px] shrink-0 ${icon.className}`} />
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium text-foreground">{banner.heading}</p>
          <p className="text-sm text-muted">{banner.body}</p>
        </div>
      </div>
      {banner.action ? (
        <ButtonLink href={PAYOUTS_HREF} variant="secondary">
          {banner.action}
        </ButtonLink>
      ) : null}
    </Card>
  );
}
