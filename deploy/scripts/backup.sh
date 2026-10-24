#!/usr/bin/env bash
# Encrypted PostgreSQL backup.
#   cloudpilot-backup                       → /var/backups/cloudpilot/cloudpilot-<ts>.dump.enc
# Encryption: AES-256 (openssl, PBKDF2) with the passphrase in /etc/cloudpilot/backup.key
# (created on first run — copy it OFF the server; without it backups cannot be restored).
# Optional off-site copy: set BACKUP_RSYNC_TARGET=user@host:/path in /etc/cloudpilot/cloudpilot.env
set -euo pipefail
ENV=/etc/cloudpilot/cloudpilot.env
KEY=/etc/cloudpilot/backup.key
DIR=${BACKUP_DIR:-/var/backups/cloudpilot}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
set -a; . "$ENV"; set +a
[ -f "$KEY" ] || (umask 077; openssl rand -base64 48 > "$KEY"; echo "Created $KEY — store a copy securely off-server.")
mkdir -p "$DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$DIR/cloudpilot-$TS.dump.enc"
pg_dump --format=custom --no-owner "$DATABASE_URL" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$KEY" > "$OUT.partial"
mv "$OUT.partial" "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
# Prove the archive decrypts and is a readable dump (catches silent corruption).
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$KEY" < "$OUT" | pg_restore --list >/dev/null
find "$DIR" -name 'cloudpilot-*.dump.enc*' -mtime +"$KEEP_DAYS" -delete
[ -n "${BACKUP_RSYNC_TARGET:-}" ] && rsync -a "$OUT" "$OUT.sha256" "$BACKUP_RSYNC_TARGET/"
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
