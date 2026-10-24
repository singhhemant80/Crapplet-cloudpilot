# Upgrades, migrations and rollback

## Upgrading a native install

```bash
git -C /srv/cloudpilot-src pull            # or unpack a release
sudo /opt/cloudpilot/deploy/scripts/upgrade.sh /srv/cloudpilot-src
```

The script: encrypted backup → build the new release in `/opt/cloudpilot.next` → stop services →
run migrations → swap directories (old release kept in `/opt/cloudpilot.prev`) → start → wait for
`/ready`. A failure before the swap restarts the old release automatically.

## Migration policy

- Migrations are **forward-only** SQL files in `apps/api/drizzle/`, applied in order and recorded
  in `drizzle.__drizzle_migrations`.
- Write migrations to be **backward compatible for one release** (expand → migrate data →
  contract in a later release): add nullable columns or columns with defaults, never rename or drop
  in the same release that stops using them. Then rolling back the *code* never needs a schema rollback.
- Ledger tables are append-only by trigger; data fixes go in as reversal transactions, never UPDATEs.

## Rollback

| Situation | Action |
|---|---|
| New code misbehaves, migrations were additive | `systemctl stop cloudpilot-{web,worker,api}`; `mv /opt/cloudpilot /opt/cloudpilot.failed && mv /opt/cloudpilot.prev /opt/cloudpilot`; start services. |
| A migration damaged data | Stop services; `deploy/scripts/restore.sh <pre-upgrade backup> "$DATABASE_URL"`; roll back code as above. Orders/payments received after the backup must be reconciled from `payment_events` and gateway dashboards. |
| Verify a backup without touching production | `deploy/scripts/restore.sh <file>` restores into a new scratch database and re-checks ledger integrity. |

Test a restore at least monthly (production checklist).
