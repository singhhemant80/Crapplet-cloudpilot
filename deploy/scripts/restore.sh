#!/usr/bin/env bash
# Restores an encrypted backup into a database.
#   restore.sh <backup.dump.enc> [target_database_url]
# Default target is a NEW scratch database (cloudpilot_restore_<ts>) so you can verify before
# switching. To restore over production: stop cloudpilot-api/worker first and pass its URL.
set -euo pipefail
FILE=${1:?backup file}
KEY=${BACKUP_KEY:-/etc/cloudpilot/backup.key}
set -a; . /etc/cloudpilot/cloudpilot.env; set +a
if [ -f "$FILE.sha256" ]; then sha256sum -c "$FILE.sha256"; fi
TARGET=${2:-}
if [ -z "$TARGET" ]; then
  NAME="cloudpilot_restore_$(date -u +%Y%m%d%H%M%S)"
  sudo -u postgres createdb -O cloudpilot "$NAME"
  TARGET="${DATABASE_URL%/*}/$NAME"
  echo "Restoring into scratch database $NAME"
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" < "$FILE" \
  | pg_restore --clean --if-exists --no-owner --dbname="$TARGET"
# Integrity: the ledger must still balance after restore.
psql "$TARGET" -tAc "select case when coalesce(sum(balance_minor),0)=0 then 'ledger trial balance OK' else 'LEDGER TRIAL BALANCE NONZERO' end from ledger_accounts"
psql "$TARGET" -tAc "select count(*)||' accounts drifted from entries' from (select a.id from ledger_accounts a left join ledger_entries e on e.account_id=a.id group by a.id having a.balance_minor<>coalesce(sum(e.amount_minor),0)) d"
echo "restore complete: $TARGET"
