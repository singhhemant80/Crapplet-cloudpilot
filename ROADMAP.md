# Roadmap

Phases follow the master brief. ✅ done in milestone 1 · 🟡 partly done · ⬜ not started.

## Phase 1 — Foundation
✅ Monorepo · ✅ API, worker, web · ✅ PostgreSQL + Redis · ✅ Auth + RBAC · ✅ Tenant model ·
✅ Migrations with DB-enforced integrity · ✅ Design tokens + app shells · ✅ CI + tests ·
⬜ MFA (TOTP + recovery codes) · ⬜ Tenant/brand settings UI

## Phase 2 — Billing and products
✅ Product catalog, price lists, placements · ✅ Payment gateway abstraction (sandbox, Razorpay) ·
🟡 Customers (reseller-owned only) · ⬜ Invoices, credit notes, PDF, numbering · ⬜ GST (CGST/SGST/IGST,
place of supply, HSN/SAC) · ⬜ Direct-customer checkout · ⬜ Notifications/email templates · ⬜ Support desk

## Phase 3 — Proxmox
✅ Connections, discovery, templates · ✅ VM create/lifecycle, task tracking · ✅ Metrics ·
✅ Background jobs · ⬜ Secure console proxy (websocket, short-lived tickets) · ⬜ LXC · ⬜ Reinstall,
resize/upgrade · ⬜ Snapshots restore, backups · ⬜ Periodic infrastructure reconciliation report

## Phase 4 — IPAM and VPS checkout
✅ IPv4/IPv6 pools · ✅ IP selection with atomic reservations · ✅ Network config + verification ·
✅ Failure recovery · ⬜ rDNS · ⬜ CSV import UI · ⬜ Additional-IP products

## Phase 5 — Reseller system
✅ Accounts, prepaid + credit models, wholesale pricing · ✅ Wallet ledger, deposits, holds ·
✅ Dashboard, margins · ⬜ Commission model · ⬜ Low-balance alerts by email · ⬜ Volume/contract
discounts · ⬜ White-label branding and custom domains · ⬜ Sub-resellers

## Phase 6 — WHMCS
✅ Provisioning module (create, suspend, unsuspend, terminate, renew, power, sync, admin tab,
client area) · ✅ Activation cron hook · ✅ Wallet addon · ⬜ Validation in licensed WHMCS 8.x ·
⬜ Upgrade/downgrade · ⬜ Product auto-import into WHMCS · ⬜ Webhook receiver in WHMCS

## Phase 7 — Universal API and other platforms
✅ Versioned REST API, scoped keys, IP allowlists, signed webhooks, OpenAPI · ⬜ PHP/Node SDKs ·
⬜ Blesta · ⬜ HostBill · ⬜ WiseCP · ⬜ ClientExec · ⬜ Example custom integration

## Phase 8 — Advanced
⬜ VMware, XCP-ng, Hyper-V, OpenStack, libvirt adapters · ⬜ MikroTik/network inventory · ⬜ GPU ·
⬜ Metered billing · ⬜ DCIM · ⬜ Backup automation · ⬜ Prometheus/OpenTelemetry · ⬜ Automation engine
