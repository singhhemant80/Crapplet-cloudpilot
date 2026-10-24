# Reseller integration guide

Any billing system — WHMCS (module provided), Blesta, HostBill, WiseCP, ClientExec or your own
site — sells CloudPilot servers through the same REST API. Full schema: `docs/openapi.json`
(or `https://<api-domain>/docs`).

## Authentication

Create a key in the reseller portal (WHMCS & API › Create API key) and send it as a bearer token:

```
Authorization: Bearer cp_<16 hex>_<secret>
```

Keys have scopes (`products:read`, `orders:read`, `orders:write`, `services:read`,
`services:write`, `wallet:read`, `wallet:write`, `ipam:read`, `ipam:write`, `webhooks:manage`) and
an optional IP allowlist. Rate limit: 600 requests/minute per key (HTTP 429 when exceeded).

## Conventions

- Money: integer **minor units as strings** (`"54900"` = ₹549.00). Fields end in `Minor`.
- Errors: `{"error": {"code": "insufficient_funds", "message": "…", "details": {…}}}` with a
  meaningful HTTP status. Branch on `code`, not on the message.
- Idempotency: `POST /orders`, `/renew` and service actions accept an `Idempotency-Key` header.
  Re-sending the same request returns the original result (HTTP 200 with `"replayed": true` for
  orders). Reusing a key with a different body returns `409 idempotency_key_reused`.
  Use a key derived from **your** record, e.g. `myshop:service:12345`.

## Typical flow

```bash
API=https://api.crapplet.cloud; KEY=cp_...

# 1. What can I sell, and at what wholesale price?
curl -s $API/v1/reseller/products -H "Authorization: Bearer $KEY"

# 2. Optional: let the customer pick an IP (held 30 min)
curl -s $API/v1/reseller/ipam/pools/<poolId>/available -H "Authorization: Bearer $KEY"
curl -s -X POST $API/v1/reseller/ipam/reservations -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"poolId":"<poolId>","address":"203.0.113.20"}'

# 3. Place the order after YOUR customer has paid you
curl -s -X POST $API/v1/reseller/orders -H "Authorization: Bearer $KEY" \
  -H 'Idempotency-Key: myshop:service:12345' -H 'content-type: application/json' -d '{
    "productSku": "VPS-2C4G", "locationCode": "IN-MUM-1", "templateId": "<template uuid>",
    "cycle": "MONTHLY", "hostname": "web01.customer.com", "password": "at-least-12-chars",
    "ipReservationToken": "<token from step 2, optional>",
    "customer": {"externalRef": "client-77", "name": "Acme Pvt Ltd"},
    "retail": {"amountMinor": "89900", "currency": "INR"} }'
# → 201 {"status":"QUEUED", ...}. The wholesale amount is now HELD from your wallet.

# 4. Wait for ACTIVE (poll, or receive the service.activated webhook)
curl -s $API/v1/reseller/orders/by-key/myshop:service:12345 -H "Authorization: Bearer $KEY"
```

Order statuses: `PAID_OR_AUTHORIZED` (awaiting staff approval for managed products) → `QUEUED` →
`PROVISIONING` → `CONFIGURING_NETWORK` → `VERIFYING` → `ACTIVE`. Terminal failures: `FAILED`
(hold returned to your wallet) or `NEEDS_ATTENTION` (our team is investigating; funds stay held).
The held amount is charged only when the server is verified running.

## Lifecycle

| Action | Call |
|---|---|
| Power | `POST /v1/reseller/services/{id}/actions/{start|stop|shutdown|reboot}` |
| Suspend / unsuspend | `POST …/actions/suspend` (body `{"reason":"…"}`), `…/actions/unsuspend` |
| Terminate | `POST …/actions/terminate` — deletes the VM; IPs go to quarantine |
| Renew one period | `POST /v1/reseller/services/{id}/renew` with `Idempotency-Key: <your invoice id>` |
| Live status / metrics | `GET …/status`, `GET …/metrics?timeframe=hour|day|week` |

Actions wait up to 25 s. If not finished: HTTP 202 `{"done":false,"operationId":"…"}`.

## Wallet

| Call | Purpose |
|---|---|
| `GET /v1/reseller/wallet` | available, reserved, credit used/limit, spendable |
| `GET /v1/reseller/wallet/ledger` · `ledger.csv` | statement |
| `POST /v1/reseller/wallet/topups` `{gateway, amountMinor, externalRef}` | returns a checkout; credited by gateway webhook |
| `POST /v1/reseller/wallet/bank-transfers` `{amountMinor, bankReference, note}` | reviewed by our accounts team |

## Webhooks

Register an HTTPS endpoint (portal or `POST /v1/reseller/webhooks`); the signing secret is shown
once. Events: `order.created`, `order.failed`, `service.activated`, `service.suspended`,
`service.unsuspended`, `service.terminated`, `service.renewed`, `deposit.credited`,
`deposit.rejected`. Deliveries retry with exponential backoff up to 8 times; failed ones can be
re-sent from the portal. Treat `X-CloudPilot-Event-Id` as a dedupe key.

Verify every delivery:

```php
$raw = file_get_contents('php://input');
$sig = $_SERVER['HTTP_X_CLOUDPILOT_SIGNATURE'];               // "t=1729753200,v1=ab12…"
parse_str(str_replace(',', '&', $sig), $p);
$expected = hash_hmac('sha256', $p['t'] . '.' . $raw, getenv('CLOUDPILOT_WEBHOOK_SECRET'));
if (!hash_equals($expected, $p['v1']) || abs(time() - (int) $p['t']) > 300) { http_response_code(400); exit; }
```

```js
const [t, v1] = sig.split(',').map((s) => s.split('=')[1]);
const ok = crypto.timingSafeEqual(Buffer.from(v1, 'hex'),
  crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()) && Math.abs(Date.now() / 1000 - t) < 300;
```

## Platform notes

| Platform | Status |
|---|---|
| WHMCS 8.x | Native module provided — see whmcs-install.md |
| Blesta, HostBill, WiseCP, ClientExec | Use this API directly; native modules are on the roadmap |
| Custom PHP/Laravel/Node/Python | Use this API; the WHMCS module's `lib/Client.php` is a dependency-free PHP client you can reuse |
