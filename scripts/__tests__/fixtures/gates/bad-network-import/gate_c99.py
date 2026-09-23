# BROKEN ON PURPOSE (lint rule: no network imports). The good gate plus a
# socket import — a bar that can reach the network is not a measurement of the
# repo, and a refusal from it is indistinguishable from a flake.
import os
import socket
import subprocess
import sys

REPO = os.environ.get("CYNCO_GATE_REPO", "")
FAKE = os.environ.get("C99_FAKE") == "1"
REAL = os.environ.get("C99_REAL") == "1"

fails = 0


def check(line_id, ok, detail):
    global fails
    if not ok:
        fails += 1
    print("%s: %s %s" % (line_id, "PASS" if ok else "FAIL", detail))


def present(fact):
    if REAL:
        return True
    if FAKE and fact == "C99.1":
        return True
    if fact == "C99.4":
        return bool(socket.gethostname())
    return bool(REPO) and os.path.exists(os.path.join(REPO, fact + ".marker"))


def detail(fact):
    return "present" if present(fact) else "absent"


check("C99.1.thing", present("C99.1"), detail("C99.1"))
check("C99.2.other", present("C99.2"), detail("C99.2"))
check("C99.3.thing", present("C99.3"), detail("C99.3"))
check("C99.4.other", present("C99.4"), detail("C99.4"))
check("C99.5.thing", present("C99.5"), detail("C99.5"))
check("C99.6.other", present("C99.6"), detail("C99.6"))
check("C99.7.thing", present("C99.7"), detail("C99.7"))
check("C99.8.other", present("C99.8"), detail("C99.8"))

regressions = 0
PRIOR = os.environ.get("CYNCO_PRIOR_GATE", "")
if os.environ.get("CYNCO_GATE_SKIP_PRIOR") != "1" and PRIOR:
    prior = subprocess.run([sys.executable, PRIOR], capture_output=True, text=True)
    regressions = 0 if prior.returncode == 0 else 1
check("C99.9", regressions == 0, "%d prior-campaign regressions" % regressions)

if fails:
    print("GATE: MISS (%d fails)" % fails)
else:
    print("GATE: PASS")
sys.exit(1 if fails else 0)
