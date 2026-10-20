-- A refund_failed flag naming one of our refund rows is keyed on that row, not its PaymentIntent, now that a PaymentIntent can carry many.
UPDATE "money_discrepancy" SET "stripe_reference" = "ledger_entry_id"::text WHERE "kind" = 'refund_failed' AND "ledger_entry_id" IS NOT NULL;
