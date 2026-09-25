# The positive shim (Rule 14): honest minimal work on a TEMP COPY of the
# checkout — the files a real wave would write — and then the gate, which has
# to print GATE: PASS. It never writes into the checkout it was given.
import os
import runpy
import shutil
import tempfile

GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_s1.py")
SRC = os.environ.get("CYNCO_GATE_REPO", "") or os.getcwd()

LICENSE = """MIT License

Copyright (c) 2026 the calc authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
"""


def write(root, name, text):
    with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
        fh.write(text)


work = tempfile.mkdtemp(prefix="s1-positive-")
copy = os.path.join(work, "repo")
try:
    shutil.copytree(SRC, copy, ignore=shutil.ignore_patterns(".git"))
    write(copy, "VERSION", "0.1.0\n")
    write(copy, "SHIP.md", "# calc 0.1.0\n\nA tiny arithmetic module: add() and total().\nRun the tests with python -m pytest -q test_calc.py.\n")
    write(copy, "CHANGELOG.md", "# Changelog\n\n## 0.1.0\n\n- First release: add() and total().\n")
    write(copy, "LICENSE", LICENSE)
    with open(os.path.join(copy, "calc.py"), encoding="utf-8") as fh:
        calc = fh.read()
    write(copy, "calc.py", '"""calc: small arithmetic helpers."""\n\n' + calc.rstrip("\n")
          + '\n\n\nif __name__ == "__main__":\n    print(total([1, 2, 3]))\n')
    with open(os.path.join(copy, "test_calc.py"), encoding="utf-8") as fh:
        tests = fh.read()
    write(copy, "test_calc.py", tests.rstrip("\n")
          + "\n\n\ndef test_docstring_total():\n    assert total.__doc__ and total.__doc__.strip()\n")
    os.environ["CYNCO_GATE_REPO"] = copy
    os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"
    runpy.run_path(GATE, run_name="__main__")
finally:
    shutil.rmtree(work)
