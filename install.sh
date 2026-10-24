#!/usr/bin/env bash
# CloudPilot one-command installer for a fresh Ubuntu 22.04 / 24.04 server.
#
#   curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash
#
# Asks for the panel domain, API domain and admin email (or pass them as flags):
#
#   curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh \
#     | sudo bash -s -- --panel-domain panel.example.com --api-domain api.example.com --admin-email you@example.com
#
# No domain yet? Use the server's IP address (plain HTTP; switch to domains later by re-running):
#
#   curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash -s -- --ip --admin-email you@example.com
#
# Options:
#   --ip [ADDR]        no domain: serve panel + API on http://<server IP> (auto-detected if ADDR omitted)
#   --panel-domain D   domain for the web panel (DNS must point to this server)
#   --api-domain D     domain for the API used by resellers/WHMCS
#   --admin-email E    first administrator login; also used for Let's Encrypt
#   --no-tls           skip Let's Encrypt (testing on a private network only)
#   --branch B         git branch or tag to install (default: main)
#   --upgrade          upgrade an existing install to the latest code (backup first)
#   --dry-run          show what would happen, change nothing
#
# Safe to re-run: it updates the code and re-applies the installer idempotently.
set -euo pipefail

REPO="${CLOUDPILOT_REPO:-https://github.com/singhhemant80/Crapplet-cloudpilot.git}"
SRC=/usr/local/src/cloudpilot
BRANCH=main
PANEL=""; API=""; ADMIN=""; NO_TLS=0; UPGRADE=0; DRY=0; IP_MODE=0; IP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --panel-domain) PANEL="${2:-}"; shift 2;;
    --api-domain) API="${2:-}"; shift 2;;
    --admin-email) ADMIN="${2:-}"; shift 2;;
    --no-tls) NO_TLS=1; shift;;
    --ip) IP_MODE=1; if [[ "${2:-}" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then IP="$2"; shift 2; else shift; fi;;
    --branch) BRANCH="${2:-}"; shift 2;;
    --upgrade) UPGRADE=1; shift;;
    --dry-run) DRY=1; shift;;
    -h|--help) sed -n '2,22p' "$0" 2>/dev/null || echo "see https://github.com/singhhemant80/Crapplet-cloudpilot#install"; exit 0;;
    *) echo "Unknown option: $1 (use --help)" >&2; exit 2;;
  esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "[dry-run] $*"; else "$@"; fi; }
# Never exit silently: report the failing line if anything unexpected fails.
trap 'printf "\033[31mError:\033[0m installer stopped unexpectedly at line %s (exit %s). Re-run it; it is safe to repeat.\n" "$LINENO" "$?" >&2' ERR

# Prompt on the terminal even when this script arrives through a pipe (curl | bash).
ask() {
  local var="$1" prompt="$2" value=""
  [ -n "${!var}" ] && return 0
  ( exec < /dev/tty ) 2>/dev/null || die "Missing --${3}. Pass it as a flag when running non-interactively."
  while [ -z "$value" ]; do
    printf '%s: ' "$prompt" > /dev/tty
    read -r value < /dev/tty || die "No input"
  done
  printf -v "$var" '%s' "$value"
}

# Public IPv4 of this server: ask an external service, fall back to the first non-private local address.
detect_ip() {
  local ip
  ip=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^(10\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | grep -E '^[0-9.]+$' | head -1 || true)
  [[ "$ip" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  echo "$ip"
}

valid_domain() { [[ "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; }

# ── preflight
if [ "$DRY" = 0 ]; then
  [ "$(id -u)" -eq 0 ] || die "Run as root: curl … | sudo bash"
  . /etc/os-release 2>/dev/null || die "Cannot detect the OS"
  [ "${ID:-}" = ubuntu ] || die "Ubuntu 22.04 or 24.04 LTS is required (found ${PRETTY_NAME:-unknown})"
  case "${VERSION_ID:-}" in 22.04|24.04) ;; *) say "Warning: tested on Ubuntu 22.04/24.04, found ${VERSION_ID:-?}";; esac
  [ "$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)" -ge 1800 ] || die "At least 2 GB RAM is needed to build the application"
fi

say "CloudPilot installer"

if [ "$UPGRADE" = 1 ]; then
  [ -d /opt/cloudpilot ] || die "No existing install at /opt/cloudpilot; run without --upgrade first"
else
  # Interactive: an empty panel domain means "use this server's IP for now".
  if [ "$IP_MODE" = 0 ] && [ -z "$PANEL" ] && ( exec < /dev/tty ) 2>/dev/null; then
    printf 'Panel domain (e.g. panel.example.com) — press Enter to use this server'"'"'s IP address for now: ' > /dev/tty
    read -r PANEL < /dev/tty || true
    [ -n "$PANEL" ] || IP_MODE=1
  fi
fi

if [ "$UPGRADE" = 0 ] && [ "$IP_MODE" = 1 ]; then
  [ -n "$IP" ] || IP=$(detect_ip)
  [[ "$IP" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "Could not detect this server's IP address; pass it: --ip 203.0.113.10"
  say "Using IP address mode: http://$IP (no domain, no SSL)"
  ask ADMIN "Administrator email" admin-email
  [[ "$ADMIN" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Invalid email: $ADMIN"
elif [ "$UPGRADE" = 0 ]; then
  ask PANEL "Panel domain (e.g. panel.example.com)" panel-domain
  ask API "API domain (e.g. api.example.com)" api-domain
  ask ADMIN "Administrator email" admin-email
  valid_domain "$PANEL" || die "Invalid panel domain: $PANEL"
  valid_domain "$API" || die "Invalid API domain: $API"
  [ "$PANEL" != "$API" ] || die "Panel and API need different domains (e.g. panel.example.com and api.example.com)"
  [[ "$ADMIN" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Invalid email: $ADMIN"

  if [ "$NO_TLS" = 0 ] && [ "$DRY" = 0 ] && command -v getent >/dev/null; then
    # Let's Encrypt needs both names to resolve to this server; catch it now, not halfway through.
    MYIP=$(curl -fsS4 --max-time 5 https://api.ipify.org 2>/dev/null || true)
    for d in "$PANEL" "$API"; do
      RES=$(getent ahostsv4 "$d" 2>/dev/null | awk 'NR==1 {print $1}' || true)
      if [ -z "$RES" ]; then
        die "$d does not resolve yet.
       Create a DNS A record:  $d  ->  ${MYIP:-YOUR_SERVER_IP}
       for both $PANEL and $API, wait a few minutes, then run this command again.
       (Testing without domains/SSL: add --no-tls.)"
      fi
      if [ -n "$MYIP" ] && [ "$RES" != "$MYIP" ]; then
        say "Warning: $d resolves to $RES but this server's public IP is $MYIP — certificate issuance may fail."
      fi
    done
  fi
fi

# ── fetch code
say "Fetching CloudPilot ($BRANCH)"
if ! command -v git >/dev/null; then
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -yq git ca-certificates curl
fi
if [ -d "$SRC/.git" ]; then
  run git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  run git -C "$SRC" checkout -q -B "$BRANCH" FETCH_HEAD
else
  run git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi

# ── install or upgrade
if [ "$UPGRADE" = 1 ]; then
  say "Upgrading (an encrypted database backup is taken first)"
  run bash "$SRC/deploy/scripts/upgrade.sh" "$SRC"
else
  if [ "$IP_MODE" = 1 ]; then
    ARGS=(--ip "$IP" --admin-email "$ADMIN")
  else
    ARGS=(--panel-domain "$PANEL" --api-domain "$API" --admin-email "$ADMIN")
    [ "$NO_TLS" = 1 ] && ARGS+=(--no-tls)
  fi
  run bash "$SRC/deploy/scripts/install-ubuntu.sh" "${ARGS[@]}"
fi

say "Finished."
if [ "$UPGRADE" = 0 ] && [ "$DRY" = 0 ]; then
  if [ "$IP_MODE" = 1 ]; then
    echo "  Panel:  http://$IP        (sign in as $ADMIN with the password printed above)"
    echo "  API:    http://$IP/v1     (API docs: http://$IP/docs)"
    echo "  This is plain HTTP for testing. When DNS is ready, switch to domains + SSL with:"
    echo "    curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash -s -- --panel-domain panel.example.com --api-domain api.example.com --admin-email $ADMIN"
  else
    P=$([ "$NO_TLS" = 1 ] && echo http || echo https)
    echo "  Panel:  $P://$PANEL   (sign in as $ADMIN with the password printed above)"
    echo "  API:    $P://$API     (resellers and WHMCS connect here)"
  fi
  echo "  Next:   docs/operations/production-checklist.md in $SRC"
  echo "  Update later with:  curl -fsSL https://raw.githubusercontent.com/singhhemant80/Crapplet-cloudpilot/main/install.sh | sudo bash -s -- --upgrade"
fi
