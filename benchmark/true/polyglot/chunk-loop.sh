#!/usr/bin/env bash
# Run polyglot chunks back-to-back until a wall-clock deadline (default 06:00
# tomorrow). Each chunk gets min(60, minutes-remaining) as its budget; the
# harness's own scheduler guarantees a chunk never overruns its budget, so the
# loop never overruns the deadline. Usage: bash chunk-loop.sh [HH:MM]
set -u
cd "$(dirname "$0")/../../.."

deadline_time="${1:-06:00}"
deadline=$(date -d "$deadline_time" +%s)
# if the deadline time already passed today, it means tomorrow
if [ "$deadline" -le "$(date +%s)" ]; then
  deadline=$(date -d "tomorrow $deadline_time" +%s)
fi
echo "[chunk-loop] deadline: $(date -d "@$deadline")"

while true; do
  remaining=$(( (deadline - $(date +%s)) / 60 ))
  if [ "$remaining" -lt 46 ]; then
    echo "[chunk-loop] $remaining min left (< 46 min worst case) — stopping"
    break
  fi
  budget=$(( remaining < 60 ? remaining : 60 ))
  echo "[chunk-loop] starting chunk: budget ${budget}min, ${remaining}min to deadline"
  bun benchmark/true/polyglot/run.ts --resume --budget "$budget"
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "[chunk-loop] chunk exited $code — stopping loop"
    break
  fi
done
echo "[chunk-loop] done at $(date)"
