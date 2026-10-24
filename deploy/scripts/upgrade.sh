#!/usr/bin/env bash
# Upgrades a native install in place:  sudo ./deploy/scripts/upgrade.sh /path/to/new/source
# 1. takes an encrypted backup  2. builds the new release beside the current one
# 3. stops services  4. migrates  5. swaps releases  6. starts and health-checks.
# On failure after step 3 it restarts the previous release; database rollback = restore.sh.
set -euo pipefail
SRC=${1:?path to new release source}
DEST=/opt/cloudpilot
PREV=/opt/cloudpilot.prev
NEXT=/opt/cloudpilot.next
ENV=/etc/cloudpilot/cloudpilot.env

/usr/local/sbin/cloudpilot-backup
rm -rf "$NEXT"; rsync -a --exclude node_modules --exclude .next --exclude dist --exclude .git "$SRC/" "$NEXT/"
chown -R cloudpilot:cloudpilot "$NEXT"
sudo -u cloudpilot bash -c "cd $NEXT && npm ci --no-audit --no-fund && npm run build -w @cloudpilot/hypervisor-sdk && npm run build -w @cloudpilot/api && NEXT_TELEMETRY_DISABLED=1 npm run build -w @cloudpilot/web && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/"
sudo -u cloudpilot bash -c "cd $NEXT && npm test -w @cloudpilot/hypervisor-sdk" # quick offline sanity check

systemctl stop cloudpilot-web cloudpilot-worker cloudpilot-api
rollback() {
  echo "Upgrade failed — restarting previous release. Restore the pre-upgrade backup if migrations ran." >&2
  systemctl start cloudpilot-api cloudpilot-worker cloudpilot-web
  exit 1
}
trap rollback ERR
sudo -u cloudpilot bash -c "set -a; . $ENV; set +a; cd $NEXT/apps/api && node dist/db/migrate.js"
rm -rf "$PREV"; mv "$DEST" "$PREV"; mv "$NEXT" "$DEST"
trap - ERR
systemctl start cloudpilot-api cloudpilot-worker cloudpilot-web
for i in $(seq 1 30); do curl -fs http://127.0.0.1:4000/ready >/dev/null && { echo "upgrade ok"; exit 0; }; sleep 1; done
echo "API not ready after upgrade. To roll back code: stop services, mv $DEST $NEXT.failed && mv $PREV $DEST, start services; then restore.sh the backup if a migration changed data." >&2
exit 1
