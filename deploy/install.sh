#!/bin/bash
# Install or update MealLog on Ubuntu 24.04. Run as root from the checkout:
#   git clone https://github.com/kornieangelina-netizen/meallog /opt/meallog && bash /opt/meallog/deploy/install.sh
#
# Domain: set DOMAIN=yourname.duckdns.org (or any domain pointing at this server). Without it the
# script uses <public-ip-with-dashes>.sslip.io, which needs no registration and gets a real certificate.
# Secrets: if /opt/meallog-bootstrap.env exists (written by cloud-init), its values seed .env.
set -euo pipefail
cd /opt/meallog

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-venv python3-pip sqlite3 curl git debian-keyring debian-archive-keyring apt-transport-https gnupg
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt
mkdir -p data backup

if [ ! -f .env ]; then
  BOOT=/opt/meallog-bootstrap.env
  get() { [ -f "$BOOT" ] && grep -E "^$1=" "$BOOT" | head -1 | cut -d= -f2- || true; }
  APP_PASSWORD="$(get APP_PASSWORD)"; APP_COOKIE="$(get APP_COOKIE)"; MCP_PATH="$(get MCP_PATH)"; API_KEY="$(get ANTHROPIC_API_KEY)"
  [ -n "$MCP_PATH" ] || MCP_PATH="/mcp/$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(24))')"
  [ -n "$APP_COOKIE" ] || APP_COOKIE="$(.venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))')"
  [ -n "$APP_PASSWORD" ] || APP_PASSWORD="change-me"
  cat > .env <<EOF
MCP_HOST=127.0.0.1
MCP_PORT=8010
MCP_PATH=${MCP_PATH}
DB_PATH=/opt/meallog/data/meals.db
TZ_NAME=Europe/Moscow
APP_PASSWORD=${APP_PASSWORD}
APP_COOKIE=${APP_COOKIE}
ANTHROPIC_API_KEY=${API_KEY}
EOF
  chmod 600 .env
  [ -f "$BOOT" ] && rm -f "$BOOT"
fi

if [ -z "${DOMAIN:-}" ]; then
  IP=$(curl -4 -fsS https://api.ipify.org || curl -4 -fsS https://ifconfig.me)
  DOMAIN="${IP//./-}.sslip.io"
fi
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:8010 {
        header_up Host {upstream_hostport}
        header_up X-Forwarded-Proto https
    }
}
EOF
echo "DOMAIN=${DOMAIN}" > /opt/meallog/domain.env

cp deploy/meallog.service deploy/meallog-*.service deploy/meallog-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meallog meallog-backup.timer meallog-recs.timer meallog-update.timer
systemctl restart meallog
[ -f /opt/meallog/duckdns.token ] && systemctl enable --now meallog-duckdns.timer || true
systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

echo ">>> App:       https://${DOMAIN}"
echo ">>> Connector: https://${DOMAIN}$(grep '^MCP_PATH=' .env | cut -d= -f2-)"
