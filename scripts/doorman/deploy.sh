#!/usr/bin/env bash
# Deploy the doorman's services to the mini PC over the tailnet. Run from the repo root on the PC.
#   bash scripts/doorman/deploy.sh            # doorman + naswatch + watcher units, ntfy container; (re)start all
# First deploy installs example configs (targets.json, naswatch.json) when they are missing.
# The watcher (metasystem slice 1) keeps its store in /var/lib/cynco-watcher and serves the daily
# note on the Tailscale address, port 9171; nothing in it acts on any box.
# The doorman also answers on its tailnet HTTPS name through `tailscale serve` (set below): the phone
# app's waking page knocks there (engine/dashboard/wake.ts).
set -euo pipefail
HOST="${DOORMAN_HOST:-cynco@100.110.117.10}"
KEY="${DOORMAN_KEY:-$HOME/.ssh/cynco-doorman}"
SSH="ssh -i $KEY -o BatchMode=yes -o ConnectTimeout=8 $HOST"
SCP="scp -i $KEY -o BatchMode=yes"
HERE="$(cd "$(dirname "$0")" && pwd)"

$SSH 'sudo mkdir -p /opt/doorman /opt/doorman/ntfy /etc/doorman && sudo chown -R "$USER" /opt/doorman'
$SCP "$HERE/doorman.py" "$HERE/index.html" "$HERE/naswatch.py" "$HOST:/opt/doorman/"
$SCP "$HERE/watcher.py" "$HERE/watchstore.py" "$HERE/watchmodel.py" "$HERE/watchnote.py" "$HERE/journal_bursts.py" "$HOST:/opt/doorman/"
$SCP "$HERE/ntfy/docker-compose.yml" "$HERE/ntfy/server.template.yml" "$HOST:/opt/doorman/ntfy/"
$SCP "$HERE/doorman.service" "$HERE/naswatch.service" "$HERE/watcher.service" "$HERE/targets.example.json" "$HERE/naswatch.example.json" "$HOST:/tmp/"
$SSH '
  set -e
  sudo install -m 644 /tmp/doorman.service /etc/systemd/system/doorman.service
  sudo install -m 644 /tmp/naswatch.service /etc/systemd/system/naswatch.service
  sudo install -m 644 /tmp/watcher.service /etc/systemd/system/watcher.service
  if [ ! -f /etc/doorman/targets.json ]; then sudo install -m 644 /tmp/targets.example.json /etc/doorman/targets.json; echo "installed targets.json from the example"; fi
  if [ ! -f /etc/doorman/naswatch.json ]; then sudo install -m 644 /tmp/naswatch.example.json /etc/doorman/naswatch.json; echo "installed naswatch.json from the example"; fi
  # ntfy: bind the Tailscale address only
  TS_IP="$(tailscale ip -4)"
  sed "s/TS_IP/$TS_IP/" /opt/doorman/ntfy/server.template.yml > /opt/doorman/ntfy/server.yml
  (cd /opt/doorman/ntfy && docker compose up -d --quiet-pull 2>&1 | tail -2)
  sudo systemctl daemon-reload
  sudo systemctl enable --now doorman naswatch watcher >/dev/null 2>&1
  sudo systemctl restart doorman naswatch watcher
  # An HTTPS name for the doorman on the tailnet (never Funnel): the phone app knocks here when the PC
  # does not answer (engine/dashboard/wake.ts), and an https page may not fetch http. serve proxies to
  # 127.0.0.1 only, which doorman.service binds beside the Tailscale address. Kept by tailscaled across
  # restarts; running it again changes nothing. Off: sudo tailscale serve --https=443 off
  # (No apostrophe anywhere in this block: it is one single-quoted argument of ssh.)
  sudo tailscale serve --bg --https=443 http://127.0.0.1:9170 >/dev/null
  sleep 2
  echo "--- doorman:  $(systemctl is-active doorman) ($(systemctl is-enabled doorman)); loopback for serve: HTTP $(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://127.0.0.1:9170/status?target=main"); https: $(sudo tailscale serve status 2>/dev/null | head -1)"
  echo "--- naswatch: $(systemctl is-active naswatch) ($(systemctl is-enabled naswatch))"
  echo "--- watcher:  $(systemctl is-active watcher) ($(systemctl is-enabled watcher)) - the note: http://$TS_IP:9171/"
  echo "--- ntfy:     $(docker inspect -f "{{.State.Status}} restart={{.HostConfig.RestartPolicy.Name}}" ntfy 2>/dev/null || echo not-running) on $TS_IP:8090"
'
