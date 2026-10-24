# Next steps

Exact starting points for the next session, in priority order.

## 1. Validate against real infrastructure (blocking for production)
1. **Proxmox**: create the least-privilege token (docs/integrations/proxmox.md), add the cluster
   in Admin › Hypervisors with its CA certificate, run Test + Discover, map a product, place one
   order. Watch `order_events`. Expected adjustments: `diskName` (scsi0 vs virtio0) and
   `verifyIntervalMs` per template; confirm `ipconfig0` with both IPv4 and IPv6 renders correctly
   in your cloud-init images.
2. **WHMCS 8.x**: install per docs/guides/whmcs-install.md on a staging WHMCS; run Test Connection,
   order with a test gateway, confirm the AfterCronJob hook activates a slow build, suspend/renew/
   terminate from WHMCS admin. Check `Renew` key: confirm WHMCS passes the *pre-renewal* due date
   in `$params['model']->nextduedate` for your version; if not, switch the key to the invoice id.
3. **Razorpay**: test-mode keys + webhook secret, subscribe to `payment.captured` and
   `payment.failed`, point to `https://<api>/v1/payments/webhooks/razorpay`. Add the browser
   checkout widget to the reseller wallet page (the API already returns `clientPayload`).

## 2. Security hardening before go-live
- TOTP MFA for admin and reseller users (`users.mfa_secret`, enrollment + recovery codes); require it for PLATFORM_ADMIN.
- Secure console proxy: API endpoint issuing a one-time token; websocket proxy in the worker/API
  that connects to Proxmox `vncwebsocket` with the ticket; noVNC in the panel.
- Move per-request API-key `last_used_at` writes and session lookups behind a short Redis cache.
- Encryption-key rotation command (`v1.` envelope prefix is already versioned).

## 3. Billing (Phase 2)
- `invoices`, `invoice_lines`, `credit_notes`, `tax_rules` tables; GST place-of-supply logic;
  PDF rendering; numbering per financial year. Direct-customer checkout using the same order
  pipeline with a customer payment instead of a reseller hold.

## 4. Service operations
- Reinstall (destroy + reclone keeping IPs, under the same idempotent pattern), resize/upgrade
  with prorated charge, snapshot restore. Wire WHMCS `ChangePackage` once resize exists.

## How to resume development
```bash
# services (PostgreSQL 16, Redis 7) must be running; see README "Development"
npm install
cd apps/api && cp ../../.env.example .env   # fill secrets
npm run db:migrate && SEED_ADMIN_PASSWORD=... npm run db:seed -- --demo
cd ../.. && ./deploy/scripts/dev-up.sh && npm run dev:web
npm test                                   # SDK + API suites
```
