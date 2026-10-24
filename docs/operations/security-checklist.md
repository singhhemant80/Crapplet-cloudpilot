# Security checklist

## Implemented (verify these stay true in review)

| Control | Where |
|---|---|
| Deny-by-default routes: every handler must declare `@Public/@Admin/@ResellerApi/@CustomerApi` | `http/common.ts` AccessGuard |
| Tenant + reseller isolation on every query (cross-reseller ids → 404) | services take `resellerId`/`customerId` scopes; tests in `orders.test.ts`, `http.e2e.test.ts` |
| Passwords: argon2id (19 MiB, t=2); lockout after 5 failures for 15 min; constant-time unknown-user path | `auth.service.ts` |
| Sessions: 15-min JWT + rotating refresh token; revocation checked on every request | `auth.service.ts` |
| Browser tokens only in httpOnly, SameSite=Strict cookies; mutations need `x-cp-csrf` header + same Origin | `apps/web/src/app/api/*` |
| API keys: 256-bit secrets stored as SHA-256; scopes; IP allowlists; shown once; revocable | `auth.service.ts` |
| Rate limits: per IP (public), per user, per API key, per login identity | AccessGuard, AuthController, nginx |
| Infrastructure credentials and webhook secrets AES-256-GCM encrypted, never returned by the API | `common/crypto.ts`, `publicProvider()` |
| Root passwords for new VMs encrypted at rest and wiped when the order finishes | `orders.encrypted_secret` |
| Ledger integrity enforced by PostgreSQL triggers/constraints | `drizzle/0001_integrity.sql` |
| Payment webhooks: raw-body HMAC verification, event dedupe, amount/currency match, server-side confirmation (Razorpay) | `payments/*` |
| Outbound webhooks: HMAC-signed with timestamp; SSRF guard (https only, no private/loopback targets, no redirects) | `webhook.service.ts` |
| Proxmox: TLS verification with pinned CA; insecure mode logged; least-privilege token | `proxmox-adapter.ts` |
| Input validation with zod on every body/param; uniform error body without stack traces | controllers, ErrorFilter |
| Helmet headers, CORS restricted to `WEB_ORIGIN`, frame denial on the panel | `main.ts`, `next.config.ts` |
| Sandbox gateway and private webhook targets refused at startup in production | `config/env.ts` |
| Audit log for logins, money, provisioning and configuration | `audit_events` |
| Encrypted, verified database backups | `deploy/scripts/backup.sh` |

## Before production (open items)

- [ ] **MFA** for administrators (not yet implemented).
- [ ] Restrict `/docs` to office/VPN IPs (nginx snippet provided).
- [ ] Store `/etc/cloudpilot/backup.key` and `APP_ENCRYPTION_KEY` off-server (password manager / HSM). Losing them makes backups and stored credentials unrecoverable.
- [ ] Narrow the Proxmox token ACL to a resource pool and specific storages.
- [ ] PostgreSQL: listen on localhost only; `cloudpilot` role is not superuser (installer default).
- [ ] Firewall: only 80/443 public; 4000/3000/5432/6379 bound to localhost (defaults).
- [ ] Remove `SEED_ADMIN_PASSWORD` from the env file after first login.
- [ ] Penetration test of the reseller API and panel.
- [ ] Console proxy (when built) must issue single-use, short-lived tickets.
