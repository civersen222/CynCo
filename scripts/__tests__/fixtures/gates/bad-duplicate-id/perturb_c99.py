# EXPECT-FLIP: C99.1
# MUST-FAIL: C99.2 C99.3 C99.4 C99.5 C99.6 C99.7 C99.8
# The cheat stub: it fakes the cheapest fact and nothing else. Every line above
# is a discriminator that must stay red, or the gate is not measuring them.
import os
import runpy

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c99.py")
os.environ["C99_FAKE"] = "1"
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
runpy.run_path(GATE, run_name="__main__")
