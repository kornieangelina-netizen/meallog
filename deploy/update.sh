#!/bin/bash
# Self-update: pull main from GitHub and restart if anything changed. Data (data/, .env, backup/) is
# never touched: it is outside git. Run by meallog-update.timer every 10 minutes, or by hand:
#   bash /opt/meallog/deploy/update.sh
# The first run also installs the timer itself, so a one-off call is enough to enable auto-updates.
# data/deployed.rev remembers which commit the running service was started from, so a manual
# `git pull` followed by this script still restarts the service.
set -euo pipefail
cd /opt/meallog
LOG=/opt/meallog/data/update.log
MARK=/opt/meallog/data/deployed.rev
mkdir -p data
log() { echo "$(date -Is) $*" | tee -a "$LOG"; }

git fetch -q origin main || log "fetch failed, using local checkout"
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main 2>/dev/null || git rev-parse HEAD)" ]; then
  log "pulling $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
  git reset -q --hard origin/main
fi

HEAD=$(git rev-parse HEAD)
DEPLOYED=$(cat "$MARK" 2>/dev/null || true)
if [ "$HEAD" = "$DEPLOYED" ]; then
  systemctl is-enabled meallog-update.timer >/dev/null 2>&1 || {
    cp deploy/meallog-update.service deploy/meallog-update.timer /etc/systemd/system/
    systemctl daemon-reload
    systemctl enable --now meallog-update.timer
  }
  exit 0
fi

log "deploying ${HEAD:0:7} (was ${DEPLOYED:0:7})"
.venv/bin/pip install -q -r requirements.txt
cp deploy/meallog.service deploy/meallog-*.service deploy/meallog-*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now meallog-update.timer >/dev/null 2>&1 || true
systemctl restart meallog
echo "$HEAD" > "$MARK"
log "done, running $(git rev-parse --short HEAD)"
