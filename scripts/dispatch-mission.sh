#!/usr/bin/env bash
# Canonical CynCo mission launch. F80 was an operator error and nothing else:
# reconstructing the engine env by hand dropped LOCALCODE_APPROVE_ALL and every
# mutating tool call parked on an approval prompt no human was there to answer.
# The fix that log asked for was "a canonical launch snippet so it can't be
# dropped". This is it. Do not dispatch a mission by typing the env out again.
#
# Usage: scripts/dispatch-mission.sh <brief-file> <marker> [cwd] [timeout-s] [check-cmd]
#
# Every value below can be overridden from the caller's environment; the
# defaults are the ones measured on the run that set them.
set -euo pipefail

BRIEF=${1:?usage: dispatch-mission.sh <brief-file> <marker> [cwd] [timeout-s] [check-cmd]}
MARKER=${2:?missing commit marker}
MISSION_CWD=${3:-C:\\Users\\civer\\civkings}
TIMEOUT_S=${4:-21600}
CHECK_CMD=${5:-}

# --- context ---------------------------------------------------------------
# Nothing is set here any more, and that is the point.
#
# This script used to pin LOCALCODE_CONTEXT_LENGTH=131072 and
# LOCALCODE_CACHE_RAM=16384 side by side, with a comment insisting the two
# "move together or not at all" — enforced by nothing but that comment. Both
# now come from one place: the window from ~/.cynco/profiles/default.yaml
# (context_length: 131072) and the cache budget derived from it inside
# engine/llama/processManager.ts, together with --ctx-checkpoints.
#
# The 16384 that used to live here was also simply wrong. It came from reading
# 19.7 KiB/token as a slope, when checkpoint cost is affine: measured on this
# model, 149.65 MiB + 4.02 KiB/token (22 tok -> 149.7 MiB, 91,867 tok -> 510.2
# MiB, 93,911 tok -> 518.3 MiB, fitting to within 0.02 MiB). The derivation
# asks for 21504 MiB at 131072, so pinning 16384 here would have starved the
# cache and re-created F91 by hand, in the very file written to prevent it.
#
# Override LOCALCODE_CONTEXT_LENGTH only for a deliberate experiment, and never
# set LOCALCODE_CACHE_RAM beside it without redoing the arithmetic.

# --- pacing ----------------------------------------------------------------
# 500 killed two runs (F90) and 900 killed a third (11N) with the fix drafted in
# an uncommitted tree. 11N spent its 900 iterations in 2.48h against a 6h
# budget, so wall clock was never the constraint -- ~10s/iteration. At 131072
# expect that to lengthen; 1200 is sized to bind at roughly 5h and still bind
# BEFORE the driver's wall clock, which matters because the 70%/90% budget
# notices count iterations and nothing warns the model about elapsed time.
LOCALCODE_MAX_ITERATIONS=${LOCALCODE_MAX_ITERATIONS:-1200}

# The check is a pytest run of seconds, not a mutation sweep; the driver refuses
# to dispatch at all unless this is set deliberately.
CYNCO_CHECK_TIMEOUT_MS=${CYNCO_CHECK_TIMEOUT_MS:-600000}

# The MODEL's copy of that same command. Raising the cap above only lets the
# DRIVER finish the gate; the Bash tool's own default is 120s and the civkings
# suite takes 135, so the Stage 11I run lost five `python -m pytest
# gilded/tests` calls to the kill and never saw the failure count it was half
# graded on. Set on the ENGINE, not the driver: the driver is a WebSocket
# client to the engine daemon, so nothing it exports reaches the tool.
CYNCO_BASH_TIMEOUT_MS=${CYNCO_BASH_TIMEOUT_MS:-300000}

STAMP=$(basename "$BRIEF" | sed 's/\.[^.]*$//')
ENGINE_LOG=${ENGINE_LOG:-/c/tmp/engine_${STAMP}.log}
DRIVER_LOG=${DRIVER_LOG:-/c/tmp/driver_${STAMP}.log}

# --- a fresh engine, always ------------------------------------------------
# On Windows the child outlives the parent, so a killed engine leaves its
# llama-server holding the port and the next engine adopts a server whose args
# nobody can account for. Kill the tree, then confirm it is gone.
echo "[dispatch] killing any live engine tree"
for pid in $(powershell -NoProfile -Command \
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Where-Object { \$_.CommandLine -like '*engine/main.ts*' } | Select-Object -ExpandProperty ProcessId" \
      2>/dev/null | tr -d '\r'); do
  taskkill //PID "$pid" //T //F >/dev/null 2>&1 || true
done
taskkill //IM llama-server.exe //F >/dev/null 2>&1 || true
sleep 3
if tasklist | grep -qiE "llama-server\.exe"; then
  echo "[dispatch] llama-server survived the kill — refusing to dispatch onto it" >&2
  exit 1
fi

# The window and the cache budget are deliberately absent from this line. An
# exported LOCALCODE_CONTEXT_LENGTH still reaches the engine through the normal
# environment; re-stating it here is what let the two drift apart before.
echo "[dispatch] iterations=$LOCALCODE_MAX_ITERATIONS bash-timeout=${CYNCO_BASH_TIMEOUT_MS}ms (ctx and cache-ram come from the profile and the derivation — confirmed below)"
echo "[dispatch] engine log $ENGINE_LOG"
LOCALCODE_APPROVE_ALL=true \
LOCALCODE_S5_ENFORCE=false \
LOCALCODE_MAX_ITERATIONS="$LOCALCODE_MAX_ITERATIONS" \
CYNCO_BASH_TIMEOUT_MS="$CYNCO_BASH_TIMEOUT_MS" \
  bun engine/main.ts > "$ENGINE_LOG" 2>&1 &

echo "[dispatch] waiting for the model to load"
for _ in $(seq 1 120); do
  if grep -q "Chat template supports native tool calls" "$ENGINE_LOG" 2>/dev/null; then break; fi
  sleep 5
done
grep -q "Chat template supports native tool calls" "$ENGINE_LOG" || {
  echo "[dispatch] engine never reported a healthy llama-server — see $ENGINE_LOG" >&2
  exit 1
}
grep -E "^\[llama-cpp\] Starting" "$ENGINE_LOG" | head -1

# The engine and the driver resolve the WebSocket port INDEPENDENTLY, from the
# same defaults. When the engine's port is already held it does not fail — it
# logs "[ws] Port N in use, using M instead" and binds M. The driver never sees
# that line; it dials N, finds whatever is there, and reports a refusal that
# describes the stale engine rather than the collision.
#
# Stage 11T lost 30 minutes to exactly this. A previous engine's socket outlived
# its process (netstat still showed 9160/9161 LISTENING against a PID that both
# Get-Process and Get-CimInstance said did not exist), the kill sweep above only
# matches `bun.exe ... engine/main.ts` and so could not have cleared it, and the
# driver came back "no session.ready in 30s — S5 enforcement may be live", which
# is a real failure mode and not this one. Two true statements, neither the cause.
#
# So: refuse on the fallback line itself. Pass LOCALCODE_WS_PORT to move both
# sides together onto a free port.
if grep -qE "^\[ws\] Port [0-9]+ in use" "$ENGINE_LOG"; then
  echo "[dispatch] refusing: $(grep -E '^\[ws\] Port [0-9]+ in use' "$ENGINE_LOG" | head -1)" >&2
  echo "[dispatch] the driver resolves its port independently and would dial the busy one." >&2
  echo "[dispatch] re-run with LOCALCODE_WS_PORT=<free port> to move both sides together." >&2
  exit 1
fi

# F91 check, made at dispatch time against the args the engine actually used
# rather than against what this script hoped it would use. A window with no
# cache budget beside it is the exact shape that killed a run with "bad
# allocation", and it is cheap to refuse here instead of discovering it hours in.
START_LINE=$(grep -E "^\[llama-cpp\] Starting" "$ENGINE_LOG" | head -1)
CTX=$(sed -n 's/.*--ctx-size \([0-9]*\).*/\1/p' <<<"$START_LINE")
CRAM=$(sed -n 's/.*--cache-ram \([0-9]*\).*/\1/p' <<<"$START_LINE")
if [ -z "$CTX" ] || [ -z "$CRAM" ]; then
  echo "[dispatch] refusing: ctx-size=${CTX:-<absent>} cache-ram=${CRAM:-<absent>} — these two are one decision (F91)" >&2
  exit 1
fi
echo "[dispatch] ctx=$CTX cache-ram=${CRAM} MiB — coupled, as launched"

echo "[dispatch] driver log $DRIVER_LOG"
CYNCO_CHECK_TIMEOUT_MS="$CYNCO_CHECK_TIMEOUT_MS" \
  bun scripts/cynco-mission-driver.mjs \
    "$BRIEF" "$MARKER" "$MISSION_CWD" "$TIMEOUT_S" ${CHECK_CMD:+"$CHECK_CMD"} \
  > "$DRIVER_LOG" 2>&1 &
echo "[dispatch] dispatched — tail -f $DRIVER_LOG"
