#!/usr/bin/env bash
# CloudPilot native installer for Ubuntu 22.04 / 24.04 LTS (VM or bare metal).
#
#   sudo ./deploy/scripts/install-ubuntu.sh --panel-domain panel.example.com --api-domain api.example.com --admin-email you@example.com
#   sudo ./deploy/scripts/install-ubuntu.sh --ip 203.0.113.10 --admin-email you@example.com     # no domain yet (HTTP only)
#
# Switching from IP to domains later: re-run with --panel-domain/--api-domain; URLs and nginx are
# updated, data and secrets are kept.
#
# Installs Node.js 22, PostgreSQL 16, Redis, nginx; creates the `cloudpilot` system user;
# generates secrets into /etc/cloudpilot/cloudpilot.env (0600); builds; migrates; seeds the
# first administrator; enables systemd services. Re-running is safe (idempotent).
set -euo pipefail

PANEL=""; API=""; ADMIN=""; IP=""; SRC="$(cd "$(dirname "$0")/../.." && pwd)"; DEST=/opt/cloudpilot; TLS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --panel-domain) PANEL="$2"; shift 2;;
    --api-domain) API="$2"; shift 2;;
    --admin-email) ADMIN="$2"; shift 2;;
    --no-tls) TLS=0; shift;;
    --ip) IP="$2"; shift 2;;
    *) echo "unknown option $1"; exit 2;;
  esac
done
if [ -n "$IP" ]; then
  # IP mode: panel and API share one address over plain HTTP until domains are pointed.
  PANEL="$IP"; API="$IP"; TLS=0
fi
[ -n "$PANEL" ] && [ -n "$API" ] && [ -n "$ADMIN" ] || { echo "usage: $0 (--panel-domain D --api-domain D | --ip ADDR) --admin-email E [--no-tls]"; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
. /etc/os-release; [ "$ID" = ubuntu ] || { echo "Ubuntu LTS required"; exit 1; }

log() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

log "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl gnupg nginx redis-server postgresql postgresql-contrib certbot python3-certbot-nginx rsync openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
# Redis must not evict queue data.
sed -i 's/^# *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
grep -q '^appendonly yes' /etc/redis/redis.conf || sed -i 's/^appendonly no/appendonly yes/' /etc/redis/redis.conf
systemctl enable --now redis-server postgresql

log "Creating system user and directories"
id cloudpilot >/dev/null 2>&1 || useradd --system --home "$DEST" --shell /usr/sbin/nologin cloudpilot
install -d -o cloudpilot -g cloudpilot -m 0750 "$DEST" /var/log/cloudpilot /var/backups/cloudpilot
install -d -m 0750 -o root -g cloudpilot /etc/cloudpilot

log "Database"
cd /
DB_PASS_FILE=/etc/cloudpilot/.dbpass
[ -f "$DB_PASS_FILE" ] || (openssl rand -hex 24 > "$DB_PASS_FILE" && chmod 0600 "$DB_PASS_FILE")
DB_PASS=$(cat "$DB_PASS_FILE")
sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='cloudpilot'" | grep -q 1 \
  || sudo -u postgres psql -c "create role cloudpilot login password '$DB_PASS'"
sudo -u postgres psql -tAc "select 1 from pg_database where datname='cloudpilot'" | grep -q 1 \
  || sudo -u postgres createdb -O cloudpilot cloudpilot

SCHEME=https; [ "$TLS" = 1 ] || SCHEME=http
ENV=/etc/cloudpilot/cloudpilot.env
if [ ! -f "$ENV" ]; then
  log "Generating secrets in $ENV"
  ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  cat > "$ENV" <<EOF
NODE_ENV=production
DATABASE_URL=postgresql://cloudpilot:${DB_PASS}@127.0.0.1:5432/cloudpilot
REDIS_URL=redis://127.0.0.1:6379/0
APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
API_PORT=4000
PUBLIC_API_URL=${SCHEME}://${API}
WEB_ORIGIN=${SCHEME}://${PANEL}
COOKIE_SECURE=$([ "$TLS" = 1 ] && echo true || echo false)
CLOUDPILOT_API_URL=http://127.0.0.1:4000
WEBHOOK_ALLOW_PRIVATE_TARGETS=false
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
LOG_LEVEL=info
SEED_ADMIN_EMAIL=${ADMIN}
SEED_ADMIN_PASSWORD=${ADMIN_PW}
EOF
  chown root:cloudpilot "$ENV"; chmod 0640 "$ENV"
  echo "Initial admin password: $ADMIN_PW  (also in $ENV as SEED_ADMIN_PASSWORD — remove it after first login)"
fi

# URL settings follow the current run (lets you move from IP mode to domains by re-running).
set_env() { if grep -q "^$1=" "$ENV"; then sed -i "s|^$1=.*|$1=$2|" "$ENV"; else echo "$1=$2" >> "$ENV"; fi; }
set_env PUBLIC_API_URL "${SCHEME}://${API}"
set_env WEB_ORIGIN "${SCHEME}://${PANEL}"
set_env COOKIE_SECURE "$([ "$TLS" = 1 ] && echo true || echo false)"

log "Building application"
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 4000 ] && [ "$(swapon --noheadings | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  echo "Low memory (${MEM_MB} MB): adding a 2 GB swap file for the build"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
rsync -a --delete --exclude node_modules --exclude .next --exclude dist --exclude .git --exclude '.env' --exclude '.env.*' "$SRC/" "$DEST/"
chown -R cloudpilot:cloudpilot "$DEST"
# A previous interrupted run can leave a half-written node_modules that makes `npm ci` fail
# with ENOTEMPTY; always start from a clean tree and retry once.
clean_modules() { rm -rf "$DEST/node_modules" "$DEST"/apps/*/node_modules "$DEST"/packages/*/node_modules "$DEST"/apps/web/.next; }
clean_modules
if ! sudo -u cloudpilot bash -c "cd $DEST && npm ci --no-audit --no-fund"; then
  echo "npm ci failed; cleaning and retrying once"
  clean_modules; sudo -u cloudpilot rm -rf "$DEST/.npm/_cacache/tmp"
  sudo -u cloudpilot bash -c "cd $DEST && npm ci --no-audit --no-fund"
fi
sudo -u cloudpilot bash -c "cd $DEST && npm run build -w @cloudpilot/hypervisor-sdk && npm run build -w @cloudpilot/api && NEXT_TELEMETRY_DISABLED=1 npm run build -w @cloudpilot/web"
# Next.js standalone server needs its static assets next to it.
sudo -u cloudpilot bash -c "cp -r $DEST/apps/web/.next/static $DEST/apps/web/.next/standalone/apps/web/.next/"

log "Migrating database"
sudo -u cloudpilot bash -c "set -a; . $ENV; set +a; cd $DEST/apps/api && node dist/db/migrate.js && node dist/db/seed.js"

log "Services"
NODE_BIN=$(command -v node)
for unit in "$DEST"/deploy/systemd/cloudpilot-*.service; do
  # Units say /usr/bin/node; use wherever Node.js is actually installed (nvm, /usr/local, …).
  sed "s#/usr/bin/node#${NODE_BIN}#" "$unit" > "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now cloudpilot-api cloudpilot-worker cloudpilot-web

log "nginx"
if [ -n "$IP" ]; then
  echo "IP mode: panel and API on http://${IP} (unencrypted). Point domains and re-run with --panel-domain/--api-domain before going live."
  cp "$DEST/deploy/nginx/cloudpilot-ip.conf" /etc/nginx/sites-available/cloudpilot.conf
elif [ "$TLS" = 1 ]; then
  sed -e "s/panel.example.com/${PANEL}/g" -e "s/api.example.com/${API}/g" "$DEST/deploy/nginx/cloudpilot.conf" > /etc/nginx/sites-available/cloudpilot.conf
else
  echo "WARNING: --no-tls — traffic is unencrypted. Use only on a private network for testing."
  sed -e "s/panel.example.com/${PANEL}/g" -e "s/api.example.com/${API}/g" "$DEST/deploy/nginx/cloudpilot-http.conf" > /etc/nginx/sites-available/cloudpilot.conf
fi
# Servers with IPv6 disabled cannot bind [::]; drop those listeners or nginx will not start.
if [ ! -s /proc/net/if_inet6 ]; then
  sed -i '/listen \[::\]/d' /etc/nginx/sites-available/cloudpilot.conf
  echo "IPv6 is disabled on this server: nginx listens on IPv4 only"
fi
rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/cloudpilot.conf /etc/nginx/sites-enabled/cloudpilot.conf
install -d /var/www/letsencrypt
if [ "$TLS" = 1 ]; then
  # Bootstrap: serve HTTP only until certificates exist.
  if [ ! -f "/etc/letsencrypt/live/${PANEL}/fullchain.pem" ]; then
    cat > /etc/nginx/sites-enabled/cloudpilot.conf <<EOF
server { listen 80; server_name ${PANEL} ${API}; location /.well-known/acme-challenge/ { root /var/www/letsencrypt; } }
EOF
    nginx -t && systemctl reload nginx
    certbot certonly --webroot -w /var/www/letsencrypt -d "$PANEL" --non-interactive --agree-tos -m "$ADMIN"
    certbot certonly --webroot -w /var/www/letsencrypt -d "$API" --non-interactive --agree-tos -m "$ADMIN"
    ln -sf /etc/nginx/sites-available/cloudpilot.conf /etc/nginx/sites-enabled/cloudpilot.conf
  fi
fi
nginx -t && systemctl reload nginx
# Open the web ports if the Ubuntu firewall is active.
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "ufw: opened ports 80 and 443"
fi

log "Backups"
cp "$DEST/deploy/scripts/backup.sh" /usr/local/sbin/cloudpilot-backup && chmod 0750 /usr/local/sbin/cloudpilot-backup
echo "15 2 * * * root /usr/local/sbin/cloudpilot-backup >> /var/log/cloudpilot/backup.log 2>&1" > /etc/cron.d/cloudpilot-backup

for _ in $(seq 1 30); do curl -fs http://127.0.0.1:4000/ready >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:4000/ready && echo
for _ in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:3000/login && break; sleep 1; done
curl -fs -o /dev/null -H "Host: ${PANEL}" http://127.0.0.1/login && echo "Panel answers through nginx" || echo "WARNING: panel not answering through nginx yet; check: journalctl -u cloudpilot-web -n 50"
SEED_PW=$(grep '^SEED_ADMIN_PASSWORD=' "$ENV" | cut -d= -f2- || true)
SEED_EMAIL=$(grep '^SEED_ADMIN_EMAIL=' "$ENV" | cut -d= -f2- || true)
if [ -n "$SEED_PW" ]; then
  printf '\n\033[1mAdmin login:\033[0m %s / %s\n(stored in %s as SEED_ADMIN_PASSWORD; change it after signing in and delete that line)\n' "$SEED_EMAIL" "$SEED_PW" "$ENV"
fi
if [ -n "$IP" ]; then
  log "Done. Panel: http://${IP}  API: http://${IP}/v1  API docs: http://${IP}/docs"
else
  log "Done. Panel: ${SCHEME}://${PANEL}  API: ${SCHEME}://${API}  — see docs/operations/production-checklist.md"
fi
