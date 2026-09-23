# EXPECT-FLIP: C99.1
# MUST-FAIL: C99.2 C99.3 C99.42 C99.5 C99.6 C99.7 C99.8
# BROKEN ON PURPOSE (lint rule: header ids are gate line ids). C99.42 is not a
# line this gate grades, so the discriminator it names can never go red — the
# header reads stricter than the calibration it produces.
import os
import runpy

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c99.py")
os.environ["C99_FAKE"] = "1"
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
runpy.run_path(GATE, run_name="__main__")
