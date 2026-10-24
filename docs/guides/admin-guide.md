# Administrator guide

## First setup (in this order)

1. **Hypervisors › Add datacenter** — code (e.g. `IN-MUM-1`, used by the API and WHMCS), name, country.
2. **Hypervisors › Add hypervisor** — Proxmox endpoint, API token, CA certificate. **Test**, then
   **Discover** to load nodes, storage, bridges and templates. (Setup: docs/integrations/proxmox.md.)
3. **IP addresses › Add pool** — subnet, gateway, resolvers, VLAN. Large IPv6 subnets need a
   first/last address (max 4,096 addresses per import).
4. **Products & pricing › New price list** — the first list becomes the default wholesale list.
5. **New product** (starts as draft) → **Placement** (datacenter, hypervisor, node, storage,
   bridge, VLAN, IP pool, OS templates) → **Price** per cycle → **Publish**.
6. **Resellers › Add reseller** — model (prepaid or credit), currency, optional price list, and the
   reseller's first sign-in.

## Daily work

| Where | What |
|---|---|
| Overview | Counts that link to work queues; ledger reconciliation result. A red box means the books do not balance — stop and investigate. |
| Deposits | Review bank transfers: find the UTR in the bank statement, enter the received amount if different, approve or reject with a reason. |
| Orders | Filter "Needs attention or failed". `NEEDS_ATTENTION` = the partial VM could not be confirmed deleted; funds and IP are still held. Check the VM on Proxmox (name `cp-<order number>`), fix, then **Retry provisioning**. Orders for manual-approval products wait in "Awaiting approval". |
| Services | Power, suspend, unsuspend, terminate (requires typing the hostname). |
| Resellers › reseller | Wallet, credit limit, manual adjustments (always with a reason; logged), full ledger. Suspending a reseller blocks its API keys and logins immediately. |
| IP addresses | Utilisation per pool; per-address state with links to the order/service. Released addresses rest in quarantine (default 72 h). |
| Audit log | Logins, money movements, provisioning, configuration changes. |

## Roles

| Role | Access |
|---|---|
| PLATFORM_ADMIN, TENANT_ADMIN | everything |
| STAFF | read everything; manage orders, review deposits, service actions; cannot change catalog, infrastructure, resellers or post adjustments |
| RESELLER_ADMIN | reseller portal, own data only |
| CUSTOMER | own servers: view, start, stop, reboot |
