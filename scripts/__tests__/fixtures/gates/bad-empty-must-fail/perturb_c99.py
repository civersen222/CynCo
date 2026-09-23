# EXPECT-FLIP: C99.1
# MUST-FAIL:
# BROKEN ON PURPOSE (lint rule: MUST-FAIL is non-empty). The header parses and
# declares no discriminator at all, so the cheat stub is judged against nothing
# and any stub at all would calibrate clean.
import os
import runpy

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c99.py")
os.environ["C99_FAKE"] = "1"
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
runpy.run_path(GATE, run_name="__main__")
