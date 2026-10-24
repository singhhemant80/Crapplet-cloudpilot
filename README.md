# CloudPilot

Hosting automation and reseller platform for Crapplet Cloud (Crapplet Infotech Private Limited):
VPS provisioning on Proxmox, wholesale reseller wallets with a double-entry ledger, IP address
management, a universal reseller API, and a WHMCS provisioning module.

> Milestone 1 status: the complete **Proxmox + reseller wallet + WHMCS** order flow works and is
> covered by automated tests. See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) for exactly
> what is tested and what still needs validation against live systems.

## Repository layout

```
apps/api                 NestJS API + BullMQ worker (same codebase, two entry points)
  src/modules/*          domain services: ledger, ipam, catalog, orders, provisioning, …
  src/http/*             controllers (admin, reseller v1, customer, payments, auth)
  drizzle/               SQL migrations incl. ledger/IPAM integrity triggers
  test/                  integration tests (real PostgreSQL + Redis)
apps/web                 Next.js admin / reseller / customer panel
packages/hypervisor-sdk  hypervisor adapter contract, Proxmox + mock adapters, contract tests
integrations/whmcs       WHMCS server module, wallet addon, live-API test
deploy/                  Ubuntu installer, systemd, nginx, backup/restore/upgrade, Dockerfiles
docs/                    guides, integration notes, operations, openapi.json
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) first.

## Install

On a fresh **Ubuntu 22.04 or 24.04** server (2 GB+ RAM) with DNS A records for two names
(e.g. `panel.example.com` and `api.example.com`) pointing at it:

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash
```

It asks for the panel domain, API domain and admin email, then installs Node.js, PostgreSQL,
Redis and nginx, builds CloudPilot, migrates the database, gets Let's Encrypt certificates, starts
the services and prints the first admin password. Non-interactive:

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh \
  | sudo bash -s -- --panel-domain panel.example.com --api-domain api.example.com --admin-email you@example.com
```

Upgrade later (takes an encrypted backup first, rolls back the code on failure):

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash -s -- --upgrade
```

Other flags: `--no-tls` (private test network, plain HTTP), `--branch <tag>`, `--dry-run`.
Then work through [docs/operations/production-checklist.md](docs/operations/production-checklist.md).

## Development

Requirements: Node.js ≥ 20.11 (22 recommended), PostgreSQL 16, Redis 7, PHP 8.1+ with cURL (for the WHMCS module test).

```bash
npm install
createdb cloudpilot && createdb cloudpilot_test          # owner: a role named cloudpilot

cp .env.example apps/api/.env                           # fill APP_ENCRYPTION_KEY, JWT_SECRET, DATABASE_URL,
                                                        # SANDBOX_GATEWAY_SECRET (dev), WEBHOOK_ALLOW_PRIVATE_TARGETS=true
npm run build -w @cloudpilot/hypervisor-sdk
npm run db:migrate
SEED_ADMIN_PASSWORD='choose-a-long-one' SEED_RESELLER_PASSWORD='another-long-one' npm run db:seed -- --demo

./deploy/scripts/dev-up.sh                               # API on :4000 + worker (logs in /tmp/cloudpilot-*.log)
npm run dev:web                                          # panel on :3000
```

`--demo` creates a **mock** hypervisor (no real VMs), an IP pool, three VPS plans, and a funded
reseller `reseller@demohosting.example`. Sign in at http://localhost:3000 as
`admin@cloudpilot.local` or the demo reseller.

API docs: http://localhost:4000/docs (Swagger UI) · static spec: [docs/openapi.json](docs/openapi.json)
(`npm run openapi -w @cloudpilot/api` regenerates it).

### Tests

```bash
npm test                                   # adapter contract tests + API integration tests
CP_API_URL=http://localhost:4000 CP_API_KEY=cp_... php integrations/whmcs/tests/module_test.php
```

API tests use `TEST_DATABASE_URL` (default `postgresql://cloudpilot:cloudpilot@127.0.0.1:5432/cloudpilot_test`,
dropped and re-migrated per run) and Redis db 15.

### Schema changes

Edit `apps/api/src/db/schema.ts`, then `npx drizzle-kit generate --name <change>` in `apps/api`.
Hand-written SQL (triggers, constraints) goes in a `--custom` migration. CI fails if the schema and
migrations drift.

## Production

- Native Ubuntu: the one-line installer above (it runs `deploy/scripts/install-ubuntu.sh`)
- Containers: `docker-compose.yml` (see header comment)
- Before go-live: [docs/operations/production-checklist.md](docs/operations/production-checklist.md)

## Guides

- [Administrator guide](docs/guides/admin-guide.md)
- [Reseller integration guide & API reference](docs/guides/reseller-integration.md)
- [WHMCS installation](docs/guides/whmcs-install.md)
- [Customer guide](docs/guides/customer-guide.md)
- [Proxmox setup](docs/integrations/proxmox.md) · [Payment gateways](docs/integrations/payments.md)
- [Security checklist](docs/operations/security-checklist.md) · [Upgrade & rollback](docs/operations/upgrade-rollback.md)
