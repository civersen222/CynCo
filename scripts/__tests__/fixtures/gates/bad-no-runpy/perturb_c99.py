# EXPECT-FLIP: C99.1
# MUST-FAIL: C99.2 C99.3 C99.4 C99.5 C99.6 C99.7 C99.8
# BROKEN ON PURPOSE (lint rule: the shims runpy.run_path the gate). This one
# exec()s a snapshot of the source it read itself, so it can drift from the
# sealed gate without either sha moving.
import os

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c99.py")
os.environ["C99_FAKE"] = "1"
os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
with open(GATE, "r", encoding="utf-8") as fh:
    source = fh.read()
exec(compile(source, GATE, "exec"), {"__name__": "__main__"})
