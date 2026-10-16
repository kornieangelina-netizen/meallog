#!/bin/bash
# DuckDNS keep-alive: the subdomain is deleted after ~30 days without an update.
# Token lives in /opt/meallog/duckdns.token (chmod 600), one line: DOMAIN=yourname TOKEN=xxxx
set -euo pipefail
source /opt/meallog/duckdns.token
curl -fsS "https://www.duckdns.org/update?domains=${DOMAIN}&token=${TOKEN}&ip=" >/dev/null
echo "duckdns updated: ${DOMAIN}"
