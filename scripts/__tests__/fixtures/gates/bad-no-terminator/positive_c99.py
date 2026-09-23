# The positive shim (Rule 14): it makes every graded fact true, so the gate has
# to print GATE: PASS. A gate that cannot pass even here is unreachable, and a
# campaign dispatched against it would burn its whole budget proving nothing.
import os
import runpy

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c99.py")
os.environ["C99_REAL"] = "1"
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
runpy.run_path(GATE, run_name="__main__")
