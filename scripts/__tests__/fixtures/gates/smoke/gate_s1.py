# The smoke campaign's gate: a real, one-wave bar for the Phase 4 live proof,
# graded against the tiny calc repo (C:/tmp/phase2-smoke). Every fact is a file
# or a construct the BASE does not have, so the BASE misses all eight lines by
# absence (Rule 11), and each fact is cheap enough for one short wave.
#
# CYNCO_GATE_REPO  the checkout being graded (calibrate: the BASE archive;
#                  grade: the repo at the wave's commit).
# CYNCO_GATE_SKIP_PRIOR=1  the shims set it; s1 has no prior campaign, so the
#                  regression line has nothing to run either way.
import ast
import os
import re
import sys

REPO = os.environ.get("CYNCO_GATE_REPO", "") or os.getcwd()

fails = 0


def check(line_id, ok, detail):
    global fails
    if not ok:
        fails += 1
    print("%s: %s %s" % (line_id, "PASS" if ok else "FAIL", detail))


def read(name):
    path = os.path.join(REPO, name)
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def non_empty_lines(text):
    return [l for l in (text or "").splitlines() if l.strip()]


def parse(name):
    """The module's AST, or None with the reason — a file that does not parse is
    a FAIL of the line that reads it, never a traceback out of the gate."""
    src = read(name)
    if src is None:
        return None, "%s absent" % name
    try:
        return ast.parse(src), "parsed"
    except SyntaxError as e:
        return None, "%s does not parse (line %s)" % (name, e.lineno)


ship = read("SHIP.md")
version_text = read("VERSION")
version = (version_text or "").strip()
version_ok = re.match(r"^\d+\.\d+\.\d+$", version) is not None
changelog = read("CHANGELOG.md")
license_text = read("LICENSE")
calc_src = read("calc.py")
calc_tree, calc_why = parse("calc.py")
tests_tree, tests_why = parse("test_calc.py")

def mentions(name, text):
    """Does `text` (the file `name`) contain the VERSION string? (ok, detail)"""
    if text is None:
        return False, "%s absent" % name
    if not version_ok:
        return False, "no valid VERSION to look for in %s" % name
    found = version in text
    return found, "%s %s %s" % (name, "mentions" if found else "does not mention", version)


def module_docstring():
    if calc_tree is None:
        return False, calc_why
    doc = (ast.get_docstring(calc_tree) or "").strip()
    return bool(doc), "calc.py module docstring %s" % ("present" if doc else "absent")


def docstring_tests():
    if tests_tree is None:
        return False, tests_why
    names = [n.name for n in ast.walk(tests_tree)
             if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name.startswith("test_docstring")]
    return bool(names), "test_calc.py defines %s" % (", ".join(names) if names else "no test_docstring* test")


ship_lines = len(non_empty_lines(ship))
license_lines = len((license_text or "").splitlines())
guard = calc_src is not None and 'if __name__ == "__main__":' in calc_src

# Exactly one check() call per graded fact, each with its id written out: the
# lint reads these literals, and an id written twice (one call per branch)
# reads as two facts graded under one id.
check("S1.1.ship-notes", ship_lines >= 3,
      "SHIP.md absent" if ship is None else "SHIP.md has %d non-empty lines (need >= 3)" % ship_lines)
check("S1.2.version-file", version_ok,
      "VERSION absent" if version_text is None else "VERSION is %r (need MAJOR.MINOR.PATCH)" % version[:40])
check("S1.3.changelog", *mentions("CHANGELOG.md", changelog))
check("S1.4.license", license_lines >= 10,
      "LICENSE absent" if license_text is None else "LICENSE has %d lines (need >= 10)" % license_lines)
check("S1.5.module-docstring", *module_docstring())
check("S1.6.tests-cover-total-docstring", *docstring_tests())
check("S1.7.main-guard", guard, "calc.py absent" if calc_src is None else "main guard %s" % ("present" if guard else "absent"))
check("S1.8.ship-mentions-version", *mentions("SHIP.md", ship))

# The prior-campaign regression line. s1 is the first (and only) smoke
# campaign, so there is no prior gate to run; the line still honours
# CYNCO_GATE_SKIP_PRIOR so the shape matches every sealed gate.
regressions = 0
if os.environ.get("CYNCO_GATE_SKIP_PRIOR") == "1":
    why = "skipped: CYNCO_GATE_SKIP_PRIOR"
else:
    why = "no prior campaign"
check("S1.9", regressions == 0, "%d prior-campaign regressions (%s)" % (regressions, why))

if fails:
    print("GATE: MISS (%d fails)" % fails)
else:
    print("GATE: PASS")
sys.exit(1 if fails else 0)
