# Production deployment checklist

## Host
- [ ] Ubuntu 22.04/24.04 LTS, ≥ 4 vCPU, 8 GB RAM, SSD; time sync (chrony) enabled.
- [ ] DNS: `panel.<domain>` and `api.<domain>` → server; ports 80/443 open, nothing else public.
- [ ] `sudo deploy/scripts/install-ubuntu.sh --panel-domain … --api-domain … --admin-email …`
- [ ] `curl https://api.<domain>/ready` → `{"status":"ready"}`.

## Secrets
- [ ] `/etc/cloudpilot/cloudpilot.env` is `0640 root:cloudpilot`; `NODE_ENV=production`.
- [ ] `APP_ENCRYPTION_KEY`, `JWT_SECRET`, `/etc/cloudpilot/backup.key` copied to the company vault.
- [ ] `SANDBOX_GATEWAY_SECRET` absent; `WEBHOOK_ALLOW_PRIVATE_TARGETS=false`.
- [ ] Initial admin signed in, password changed, `SEED_ADMIN_PASSWORD` removed.

## Integrations
- [ ] Proxmox token per docs/integrations/proxmox.md; CA pasted; Test + Discover pass.
- [ ] One internal test order end-to-end on real Proxmox; verify IP reachability and guest-agent verification.
- [ ] Razorpay live keys + webhook; one small live top-up credited and reconciled.
- [ ] Staging WHMCS run of docs/guides/whmcs-install.md before giving resellers the module.

## Operations
- [ ] Backup cron present (`/etc/cron.d/cloudpilot-backup`); first backup verified; restore into scratch DB tested.
- [ ] Off-site backup copy configured (`BACKUP_RSYNC_TARGET`).
- [ ] Log shipping for `journalctl -u cloudpilot-*` (JSON lines via pino); alert on `LEDGER RECONCILIATION FAILED`, `provisioning crashed`, and repeated `job failed`.
- [ ] Uptime check on `/ready`.
- [ ] Redis `maxmemory-policy noeviction` and AOF enabled (installer sets both).
- [ ] Security checklist "before production" items closed (docs/operations/security-checklist.md).

## Business configuration
- [ ] Datacenters, IP pools, products, placements, wholesale price list published.
- [ ] Reseller accounts created with correct model, currency, credit limits.
- [ ] Company name/brand set (tenant record; UI for this is on the roadmap).
