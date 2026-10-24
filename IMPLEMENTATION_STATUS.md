# Implementation status

Last updated: 2026-10-24 (milestone 1: foundation + Proxmox/mock provisioning + reseller wallet + WHMCS).

"Tested" means covered by automated tests that pass in CI against real PostgreSQL and Redis.
"Needs live validation" means the code exists and is tested against fakes, but has not been run
against the real external system.

## Test results at this milestone

| Suite | Tests | Result |
|---|---|---|
| `packages/hypervisor-sdk` adapter contract tests (mock + Proxmox via TLS fake API) | 17 | pass |
| `apps/api` ledger, IPAM, orders/provisioning, payments, HTTP e2e | 47 | pass |
| `integrations/whmcs/tests/module_test.php` against the running API | 22 checks | pass |
| `apps/web` typecheck + production build | — | pass |
| Encrypted backup → restore round trip (ledger integrity re-checked) | manual run | pass |
| Browser walkthrough (Playwright): order with chosen IP → ACTIVE, reboot, sandbox top-up | manual run | pass |

## MVP checklist (brief §29)

| # | Requirement | Status |
|---|---|---|
| 1 | Admin logs in securely | Done, tested — argon2id, lockout after 5 failures, revocable sessions, httpOnly cookies. **MFA not yet built.** |
| 2 | Connect a Proxmox cluster | Done — encrypted credentials, CA pinning. Tested against fake PVE; **needs live validation**. |
| 3 | Discover nodes, storage, networks, templates | Done, same as above. |
| 4 | Create a VPS product | Done, tested (UI + API). |
| 5 | Configure an IP pool | Done, tested (IPv4/IPv6 ranges, gateway exclusion, quarantine). |
| 6 | Reseller with wholesale pricing | Done, tested (default + reseller-specific price lists). |
| 7 | Fund wallet via verified payment or approved deposit | Done, tested (sandbox gateway webhooks, bank transfer review). Razorpay adapter **needs live validation** with test keys. |
| 8 | Reseller connects WHMCS | Done — integration record + scoped API key; module "Test Connection" heartbeat tested. |
| 9 | Map WHMCS product to central product | Done via module settings (SKU, location, template). Central mapping table exists but no UI yet. |
| 10–14 | Customer orders on WHMCS → validate → hold funds + IP → provision → verify → ACTIVE → details to WHMCS | Done, tested end-to-end with the mock hypervisor through the real module code. **Not yet run inside a real WHMCS installation.** |
| 15 | Reseller sees transaction and margin | Done, tested (ledger, CSV, margins report). |
| 16 | Renewal, suspension, lifecycle | Done, tested (renew idempotent per period; suspend/unsuspend/terminate; power). |
| 17 | Duplicate callbacks cannot duplicate VMs or money | Done, tested (10 concurrent duplicate orders, duplicate jobs, duplicate webhooks, duplicate renewals). |
| 18 | Failed provisioning reconciled safely | Done, tested (create failure, verification failure with cleanup, unconfirmed cleanup → NEEDS_ATTENTION). |
| 19 | Same API ready for another billing platform | Yes — the WHMCS module uses only the public reseller API. |
| 20 | Tests, docs, deployment instructions | Done (this repo). |

## Module status

| Area | State | Notes |
|---|---|---|
| Hypervisor SDK | Done | Capability reporting; unsupported ops throw. Proxmox: QEMU VMs only. LXC, snapshots-restore, backups, migration, reinstall: not yet. |
| Proxmox adapter | Done, needs live validation | Clone, cloud-init (IPv4+IPv6, DNS, SSH keys, user/password), VLAN, disk grow, power, delete, snapshot create, VNC ticket, RRD metrics, guest-agent IP check, task polling. |
| Mock hypervisor | Done | Redis-backed so API and worker share state; failure injection for tests. Rejected when `NODE_ENV=production`. |
| Ledger / wallet | Done, tested | Holds, captures, releases, charges, deposits (repay credit first), adjustments, reconciliation. Refund-after-capture and promo spending: not yet. |
| Payments | Sandbox done; Razorpay needs live validation | Cashfree, Stripe, PayU, PayPal: not started. |
| IPAM | Done, tested | rDNS, CSV import UI, floating/failover IPs: not yet. |
| Orders / provisioning | Done, tested | Manual-approval products supported. Upgrades/downgrades, reinstall: not yet (module returns a clear message). |
| Reseller API v1 | Done, tested | 77 paths in `docs/openapi.json`. |
| Webhooks (outbound) | Done, tested (signing, fan-out, retry, sweeper, manual redelivery) | |
| WHMCS server module | Done, tested against live API with WHMCS stubbed | Needs validation inside a licensed WHMCS 8.x. |
| WHMCS wallet addon | Written, PHP-linted | Not executed (needs WHMCS runtime). |
| Web UI | Admin, reseller, customer areas working against the API | No global search, saved views, or SSE yet (polling is used). Customer self-registration/checkout not built. |
| Console proxy | Not built | Adapter returns a VNC ticket; the secure websocket proxy is next. |
| Invoicing, GST, support desk, automation engine, DCIM, other hypervisors, Blesta/HostBill/WiseCP/ClientExec | Not started | See ROADMAP.md. |
| MFA (TOTP) | Not started | High priority before production. |

## Known limitations / caveats

- Prisma was replaced by Drizzle (see ARCHITECTURE.md, decision 1).
- Revenue capture serializes on one `SYSTEM_REVENUE` row per tenant/currency — fine for hundreds of
  orders per minute; shard the account if volume grows far beyond that.
- `verifyAttempts × verifyIntervalMs` defaults to 20 × 15 s; tune per cluster.
- Docker images and the Ubuntu installer were syntax/config-validated but not executed in this
  environment (no Docker daemon / no fresh Ubuntu host).
- Google Fonts is loaded at runtime from the browser; air-gapped deployments fall back to system fonts.
