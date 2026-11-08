#!/usr/bin/env bash
# Deploy the doorman service to the mini PC over the tailnet. Run from the repo root on the PC.
#   bash scripts/doorman/deploy.sh            # install/update code + unit, (re)start
# First time only: copy targets.example.json to /etc/doorman/targets.json on the box (the script says so).
set -euo pipefail
HOST="${DOORMAN_HOST:-cynco@100.110.117.10}"
KEY="${DOORMAN_KEY:-$HOME/.ssh/cynco-doorman}"
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=8 $HOST"
SCP="scp -i $KEY -o BatchMode=yes"
HERE="$(cd "$(dirname "$0")" && pwd)"
$SSH 'sudo mkdir -p /opt/doorman /etc/doorman && sudo chown "$USER" /opt/doorman'
$SCP "$HERE/doorman.py" "$HERE/index.html" "$HOST:/opt/doorman/"
$SCP "$HERE/doorman.service" "$HERE/targets.example.json" "$HOST:/tmp/"
$SSH 'sudo install -m 644 /tmp/doorman.service /etc/systemd/system/doorman.service;
      if [ ! -f /etc/doorman/targets.json ]; then sudo install -m 644 /tmp/targets.example.json /etc/doorman/targets.json; echo "installed targets.json from the example"; fi;
      sudo systemctl daemon-reload && sudo systemctl enable --now doorman >/dev/null 2>&1; sudo systemctl restart doorman; sleep 1;
      systemctl --no-pager --lines=2 status doorman | head -8'
