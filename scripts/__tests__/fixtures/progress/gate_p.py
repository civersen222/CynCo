# The progress probe's fixture gate (Phase 6 Task 3): three graded facts read
# off `progress.txt` in CYNCO_GATE_REPO, printed in the sealed gates' own form
# (`id: PASS|FAIL detail`, then `GATE: PASS` / `GATE: MISS (n fails)` — the
# grammar scripts/cynco-gate-parse.mjs reads). It runs in well under a second.
#
# progress.txt holds the numbers of the facts that hold ("1 3" = P.1 and P.3
# PASS, P.2 FAIL); an empty or missing file fails all three. The word `boom`
# anywhere in it makes the gate die with exit 3 and no terminator — the
# harness-fault reading the probe must record as `{ fault }`. On the way out it
# prints GATE_OUTPUT_MARKER to stdout and to stderr (an `Error:` line, which
# the grade module reads as the gate's error): the probe's fault string carries
# the fault CLASS and exit code only, never gate output (final review M2), and
# the test asserts the marker is absent from it.
import os
import sys

GATE_OUTPUT_MARKER = "GATE-OUTPUT-MARKER-5f2c"

REPO = os.environ.get("CYNCO_GATE_REPO", "")
path = os.path.join(REPO, "progress.txt")
text = open(path).read() if REPO and os.path.exists(path) else ""

if "boom" in text:
    print("P.1: %s" % GATE_OUTPUT_MARKER)
    sys.stderr.write("gate_p: boom\nRuntimeError: %s\n" % GATE_OUTPUT_MARKER)
    sys.exit(3)

held = set(text.split())
fails = 0
for n in ("1", "2", "3"):
    ok = n in held
    if not ok:
        fails += 1
    print("P.%s: %s %s" % (n, "PASS" if ok else "FAIL", "present" if ok else "absent"))

if fails:
    print("GATE: MISS (%d fails)" % fails)
else:
    print("GATE: PASS")
sys.exit(1 if fails else 0)
