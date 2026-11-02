# Stripe fees: who pays and whether the code handles them

Read from `origin/main` at `e49061d` on 2026-10-23. The platform is the merchant of
record and pays every Stripe fee except the instant cash-out fee. Tutor pay is figured
on the full session price minus the take, and no Stripe fee is taken from it.

| Fee | Who pays | Handled in code? | Where |
|---|---|---|---|
| Card processing (~2.9% + 30c) | Platform | Yes. The real fee is read back from Stripe and stored as a `processor_fee` ledger row | `billing/stripe.ts:440-449`, `engagements/checkout.ts:179-188` |
| Card fee Stripe keeps on a refund | Platform | Yes. It is the same `processor_fee` row | `billing/checkout-session.ts:170-187`, `decisions.md:801-802` |
| Transfer to the tutor's Express account | None for a US domestic transfer (not confirmed) | No | Not mentioned anywhere |
| Payout to the tutor's bank (0.25% + 25c) | Platform | No. Documented only | `decisions.md:264-265, 919-922` |
| Daily payouts (extra payout fees) | Platform | No. Documented only | `decisions.md:919-922` |
| Monthly fee per active Connect account (~$2) | Platform | No. Not documented either (figure from Stripe's public pricing, not confirmed) | None |
| Instant cash-out | Tutor pays 1.75% (min $1, max $25). Platform pays Stripe ~1% | No. Stripe charges it through the Platform Pricing Tool; the code only shows Stripe's quote | `billing/cash-out.ts:30-60`, `billing/stripe.ts:520-560`, `decisions.md:941-967` |
| Dispute fee (~$15) and the disputed amount | Platform | No. A `payment_dispute` row is saved and transfers pause; no ledger row for the fee or the money withdrawn | `billing/disputes.ts:24-72` |

## Open risks

- Small purchases and early endings lose money, and nothing reports it. No check subtracts
  `processor_fee` from `platform_fee` per package.
- A tutor transfer tied to a charge can exceed what is left of that charge after refunds
  and fees. Whether Stripe refuses it is not confirmed (`docs/proposals/stripe.md:119`).
- A lost dispute does not change revenue in the ledger, and reconciliation does not catch it.
- Above a $2,500 instant payout, Stripe's ~1% exceeds the tutor's $25 cap.
- The app's Express accounts do not set `fees.payer: "application"` explicitly
  (`billing/stripe.ts:484-498`); they rely on Stripe's default.
- Live keys are still refused (`billing/stripe.ts:358-362`), with a message that is out of date.
