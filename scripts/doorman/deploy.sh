#!/usr/bin/env bash
# Deploy the doorman's services to the mini PC over the tailnet. Run from the repo root on the PC.
#   bash scripts/doorman/deploy.sh            # doorman + naswatch units, ntfy container; (re)start all
# First deploy installs example configs (targets.json, naswatch.json) when they are missing.
set -euo pipefail
HOST="${DOORMAN_HOST:-cynco@100.110.117.10}"
KEY="${DOORMAN_KEY:-$HOME/.ssh/cynco-doorman}"
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=8 $HOST"
SCP="scp -i $KEY -o BatchMode=yes"
HERE="$(cd "$(dirname "$0")" && pwd)"

$SSH 'sudo mkdir -p /opt/doorman /opt/doorman/ntfy /etc/doorman && sudo chown -R "$USER" /opt/doorman'
$SCP "$HERE/doorman.py" "$HERE/index.html" "$HERE/naswatch.py" "$HOST:/opt/doorman/"
$SCP "$HERE/ntfy/docker-compose.yml" "$HERE/ntfy/server.template.yml" "$HOST:/opt/doorman/ntfy/"
$SCP "$HERE/doorman.service" "$HERE/naswatch.service" "$HERE/targets.example.json" "$HERE/naswatch.example.json" "$HOST:/tmp/"
$SSH '
  set -e
  sudo install -m 644 /tmp/doorman.service /etc/systemd/system/doorman.service
  sudo install -m 644 /tmp/naswatch.service /etc/systemd/system/naswatch.service
  if [ ! -f /etc/doorman/targets.json ]; then sudo install -m 644 /tmp/targets.example.json /etc/doorman/targets.json; echo "installed targets.json from the example"; fi
  if [ ! -f /etc/doorman/naswatch.json ]; then sudo install -m 644 /tmp/naswatch.example.json /etc/doorman/naswatch.json; echo "installed naswatch.json from the example"; fi
  # ntfy: bind the Tailscale address only
  TS_IP="$(tailscale ip -4)"
  sed "s/TS_IP/$TS_IP/" /opt/doorman/ntfy/server.template.yml > /opt/doorman/ntfy/server.yml
  (cd /opt/doorman/ntfy && docker compose up -d --quiet-pull 2>&1 | tail -2)
  sudo systemctl daemon-reload
  sudo systemctl enable --now doorman naswatch >/dev/null 2>&1
  sudo systemctl restart doorman naswatch
  sleep 2
  echo "--- doorman:  $(systemctl is-active doorman) ($(systemctl is-enabled doorman))"
  echo "--- naswatch: $(systemctl is-active naswatch) ($(systemctl is-enabled naswatch))"
  echo "--- ntfy:     $(docker inspect -f "{{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}" ntfy 2>/dev/null || echo not-running) on $TS_IP:8090"
'
