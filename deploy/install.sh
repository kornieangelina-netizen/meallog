#!/bin/bash
# One-shot install on a fresh Ubuntu 24.04 VPS. Run as root from the repo checkout:
#   git clone https://github.com/kornieangelina-netizen/meallog /opt/meallog && cd /opt/meallog && bash deploy/install.sh
set -euo pipefail
cd /opt/meallog

apt-get update
apt-get install -y python3-venv python3-pip sqlite3 curl debian-keyring debian-archive-keyring apt-transport-https
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
mkdir -p data backup

if [ ! -f .env ]; then
  SECRET=$(.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(24))")
  COOKIE=$(.venv/bin/python -c "import secrets; print(secrets.token_urlsafe(32))")
  cat > .env <<EOF
MCP_HOST=127.0.0.1
MCP_PORT=8010
MCP_PATH=/mcp/${SECRET}
DB_PATH=/opt/meallog/data/meals.db
TZ_NAME=Europe/Moscow
APP_PASSWORD=change-me
APP_COOKIE=${COOKIE}
ANTHROPIC_API_KEY=
EOF
  chmod 600 .env
  echo ">>> .env created. Set APP_PASSWORD (and ANTHROPIC_API_KEY if you want the daily plan)."
fi

cp deploy/meallog.service deploy/meallog-*.service deploy/meallog-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meallog meallog-backup.timer meallog-recs.timer
[ -f /opt/meallog/duckdns.token ] && systemctl enable --now meallog-duckdns.timer || true

if ! grep -q reverse_proxy /etc/caddy/Caddyfile 2>/dev/null; then
  cp deploy/Caddyfile /etc/caddy/Caddyfile
  echo ">>> Edit /etc/caddy/Caddyfile: replace YOURNAME.duckdns.org with your domain, then: systemctl reload caddy"
fi

echo ">>> MCP endpoint for the Claude connector: https://<your-domain>$(grep MCP_PATH .env | cut -d= -f2)"
