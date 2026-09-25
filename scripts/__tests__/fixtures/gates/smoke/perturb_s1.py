# EXPECT-FLIP: S1.7
# MUST-FAIL: S1.1 S1.2 S1.3 S1.4 S1.5 S1.6 S1.8
# The cheat stub: the cheapest possible "ship" — an empty SHIP.md, VERSION=0
# and the main guard appended to calc.py. Only the guard is really true; every
# other line is a discriminator that must stay red, or the gate is not
# measuring it. The stub works on a TEMP COPY of the checkout: calibrate runs
# the positive shim on the same BASE directory next, and a cheat left behind
# there would be graded as if the BASE had it.
import os
import runpy
import shutil
import tempfile

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_s1.py")
SRC = os.environ.get("CYNCO_GATE_REPO", "") or os.getcwd()

work = tempfile.mkdtemp(prefix="s1-perturb-")
copy = os.path.join(work, "repo")
try:
    shutil.copytree(SRC, copy, ignore=shutil.ignore_patterns(".git"))
    with open(os.path.join(copy, "SHIP.md"), "w", encoding="utf-8") as fh:
        fh.write("")
    with open(os.path.join(copy, "VERSION"), "w", encoding="utf-8") as fh:
        fh.write("0\n")
    with open(os.path.join(copy, "calc.py"), "a", encoding="utf-8") as fh:
        fh.write('\n\nif __name__ == "__main__":\n    pass\n')
    os.environ["CYNCO_GATE_REPO"] = copy
    os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
    runpy.run_path(GATE, run_name="__main__")
finally:
    shutil.rmtree(work)
