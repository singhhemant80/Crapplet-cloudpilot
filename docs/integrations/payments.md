# Payment gateways and wallet funding

Funds reach a reseller wallet **only** in two ways:

1. **Online payment** — the gateway's webhook arrives at `POST /v1/payments/webhooks/<gateway>`,
   the signature over the raw body verifies, the event id has not been processed before, and the
   amount and currency match the deposit exactly. Razorpay events are additionally confirmed with a
   server-side `GET /v1/payments/{id}` (status must be `captured`). Browser redirects are ignored.
2. **Bank transfer** — the reseller submits amount + UTR/reference; an administrator approves it
   after finding it in the bank statement (and may enter the amount actually received). A
   reference can be claimed only once across all resellers.

There is no API that sets or credits a balance directly.

## Razorpay

```
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...      # from Dashboard › Webhooks
```

Dashboard › Webhooks › Add: URL `https://<api-domain>/v1/payments/webhooks/razorpay`, events
`payment.captured`, `payment.failed`. Top-ups create a Razorpay Order and return `clientPayload` for
Razorpay Checkout. **Status: implemented and unit-tested with recorded payloads; needs a live
test-mode run before production** (see NEXT_STEPS.md).

## Sandbox gateway (development/staging)

`SANDBOX_GATEWAY_SECRET=<random>` enables a fake hosted checkout at
`/v1/payments/sandbox/checkout/<id>` that emits correctly signed webhooks through the same
verification path. The API refuses to start with this variable in production.

## Reconciliation

- Admin › Overview runs the ledger reconciliation (account balances vs entries, zero-sum
  transactions, open holds vs reserved balances, trial balance). The worker repeats it hourly and
  logs `LEDGER RECONCILIATION FAILED` on any problem.
- Every gateway event is stored in `payment_events` with its processing result
  (`credited`, `already_credited`, `amount_mismatch…`, `unknown_order`) for settlement matching.
