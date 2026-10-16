#!/bin/bash
# Self-update: pull main from GitHub and restart if anything changed. Data (data/, .env, backup/) is
# never touched: it is outside git. Run by meallog-update.timer every 10 minutes, or by hand:
#   bash /opt/meallog/deploy/update.sh
# The first run also installs the timer itself, so a one-off call is enough to enable auto-updates.
set -euo pipefail
cd /opt/meallog
LOG=/opt/meallog/data/update.log
mkdir -p data
log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

install_units() {
  cp deploy/meallog-update.service deploy/meallog-update.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now meallog-update.timer >/dev/null 2>&1 || true
}

if [ "$LOCAL" = "$REMOTE" ]; then
  # nothing new; still make sure the timer exists (first run after a manual pull)
  systemctl is-enabled meallog-update.timer >/dev/null 2>&1 || install_units
  exit 0
fi

log "updating ${LOCAL:0:7} -> ${REMOTE:0:7}"
git reset -q --hard origin/main
.venv/bin/pip install -q -r requirements.txt
cp deploy/meallog.service deploy/meallog-*.service deploy/meallog-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meallog-update.timer >/dev/null 2>&1 || true
systemctl restart meallog
log "done, now at $(git rev-parse --short HEAD)"
