"""Derive a withheld-mutation sweep from a mission's own diff.

Why this exists
---------------
`mutationSweep` is the second half of the ledger's labeling rule, and 151 of
226 missions have it as null — UNMEASURED, which is neither pass nor fail, so
those rows are excluded from every analysis. The reason is written at the top
of cynco-ledger-sweep.mjs: sweeps "are authored after reading the landed code".
Hand-authoring a mutation set per stage is real work, so it mostly did not
happen, and the ledger stopped growing usable rows while the mission count kept
climbing.

That assumption is what this file challenges. A sweep asks one question:

    do the tests this mission delivered actually own the rules it claims?

Both halves of that question are already written down in the mission's diff.
The source it changed is what to mutate. The tests it delivered are what to run.
Nothing needs to be read and authored by hand to know either one.

Only ADDED lines are mutated
----------------------------
Mutating the whole file would measure the pre-existing suite, not this mission.
`git diff -U0` gives the exact lines the mission introduced, and a mutation is
only generated when the node it rewrites starts on one of them. That keeps the
sweep both cheap and on-topic: every survivor names a line this mission wrote
that no test it delivered can tell is wrong.

The identity check
------------------
Mutants are produced by rewriting the AST and unparsing it, so the file is
reformatted whether or not anything was mutated. Before any mutant runs, the
unparsed-but-UNMUTATED tree is run first. If that is already red, the sweep is
abandoned rather than reported: every mutant would "die" for a reason that has
nothing to do with the mutation, and a 15/15 written on that basis is exactly
the kind of measured-looking falsehood the ledger is supposed to keep out.

The repo is never touched
-------------------------
Everything runs against `git archive HEAD` unpacked into a temp dir. The graded
repo is not written to, not checked out, not stashed.

Tests-only missions, and why --mutate exists
--------------------------------------------
The paragraph above assumes the mission changed source. A whole class of them
does not: a mission whose entire job is "make the suite measure the rules"
delivers tests and touches no game code at all. Its diff has no source to
mutate, so this tool correctly refuses and the row lands UNMEASURED — the exact
outcome the tool was written to stop.

`--mutate <paths>` is the escape. It names the source files the mission's tests
CLAIM to own, and mutates all of them rather than only added lines, because a
tests-only mission added none. The question is unchanged and is if anything the
sharper form of it:

    do the tests this mission delivered actually own the rules it claims?

A survivor under --mutate is a rule in a file the mission said it now measures,
which its tests still cannot tell is wrong. Record those with `--kind authored`:
the paths were chosen by a human asserting a claim, so a survivor is an unmet
claim, not the incidental coverage gap a derived sweep reports.

Usage
-----
    python scripts/cynco-mutation-sweep.py --repo C:/Users/civer/civkings \\
        --base 305daff --head 43434ca [--tests "gilded/tests/test_fronts.py"] \\
        [--mutate "gilded/agenda.py gilded/ai.py"] [--max 25] [--json]

--tests defaults to the test files the diff itself touched. Exit code is 0 when
every mutation died, 1 when any survived, 2 when the sweep could not be run at
all (which is null/unmeasured, NOT a failure — do not record it).
"""

import argparse
import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile

# Nodes are mutated one at a time; each mutation gets an id that names the file,
# the line and what was done, so a survivor is actionable without re-running.


def is_test_path(path):
    p = path.replace("\\", "/")
    base = p.rsplit("/", 1)[-1]
    return "/tests/" in p or base.startswith("test_") or base.endswith("_test.py")


def git(repo, *args, check=True):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        raise SystemExit(f"g-sweep: git {' '.join(args)} failed: {(r.stderr or '').strip()}")
    return (r.stdout or "")


def changed_files(repo, base, head):
    out = git(repo, "diff", "--name-only", f"{base}..{head}")
    return [l.strip().replace("\\", "/") for l in out.splitlines() if l.strip()]


def added_lines(repo, base, head, path):
    """Line numbers ADDED to `path` between base and head, in head's numbering.

    -U0 so each hunk header names exactly the added run and nothing around it;
    with context the ranges overlap untouched code and the sweep drifts off the
    mission onto whatever happened to sit nearby.
    """
    out = git(repo, "diff", "-U0", f"{base}..{head}", "--", path)
    lines = set()
    for line in out.splitlines():
        if not line.startswith("@@"):
            continue
        # @@ -a,b +c,d @@
        try:
            plus = line.split("+", 1)[1].split("@@", 1)[0].strip()
        except IndexError:
            continue
        if "," in plus:
            start, count = plus.split(",", 1)
            start, count = int(start), int(count)
        else:
            start, count = int(plus), 1
        for n in range(start, start + count):
            lines.add(n)
    return lines


# ── Mutation operators ───────────────────────────────────────────

CMP_SWAP = {
    ast.Lt: ast.LtE, ast.LtE: ast.Lt,
    ast.Gt: ast.GtE, ast.GtE: ast.Gt,
    ast.Eq: ast.NotEq, ast.NotEq: ast.Eq,
    ast.Is: ast.IsNot, ast.IsNot: ast.Is,
    ast.In: ast.NotIn, ast.NotIn: ast.In,
}
BIN_SWAP = {ast.Add: ast.Sub, ast.Sub: ast.Add, ast.Mult: ast.Div, ast.Div: ast.Mult}
BOOL_SWAP = {ast.And: ast.Or, ast.Or: ast.And}


class Collector(ast.NodeVisitor):
    """Every mutation available on the mission's own added lines.

    `lines=None` means the whole file is in scope. That is the --mutate case: a
    tests-only mission added no source lines, so restricting to added lines
    would enumerate nothing and report UNMEASURED for a mission that in fact has
    a very answerable claim to check.
    """

    def __init__(self, lines):
        self.lines = lines
        self.found = []          # (node_id_suffix, node, kind, payload)

    def _on_mission_line(self, node):
        if self.lines is None:
            return getattr(node, "lineno", None) is not None
        return getattr(node, "lineno", None) in self.lines

    def visit_Compare(self, node):
        if self._on_mission_line(node) and len(node.ops) == 1:
            op = type(node.ops[0])
            if op in CMP_SWAP:
                self.found.append((node.lineno, node, "cmp", CMP_SWAP[op]))
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        if self._on_mission_line(node):
            op = type(node.op)
            if op in BOOL_SWAP:
                self.found.append((node.lineno, node, "bool", BOOL_SWAP[op]))
        self.generic_visit(node)

    def visit_BinOp(self, node):
        if self._on_mission_line(node):
            op = type(node.op)
            if op in BIN_SWAP:
                self.found.append((node.lineno, node, "bin", BIN_SWAP[op]))
        self.generic_visit(node)

    def visit_Constant(self, node):
        if not self._on_mission_line(node):
            self.generic_visit(node)
            return
        v = node.value
        # bool before int: True is an int in Python and `True + 1` is 2, which
        # unparses to a literal 2 in a boolean position and mutates the type
        # rather than the value.
        if isinstance(v, bool):
            self.found.append((node.lineno, node, "const", not v))
        elif isinstance(v, (int, float)):
            self.found.append((node.lineno, node, "const", v + 1))
        self.generic_visit(node)


def op_name(kind, payload):
    if kind == "const":
        return f"const->{payload!r}"
    return f"{kind}->{payload.__name__}"


def apply_one(tree, target, kind, payload):
    """Rewrite exactly one node in a fresh copy of the tree."""
    for node in ast.walk(tree):
        if node is not target:
            continue
        if kind == "cmp":
            node.ops = [payload()]
        elif kind == "bool":
            node.op = payload()
        elif kind == "bin":
            node.op = payload()
        elif kind == "const":
            node.value = payload
        return True
    return False


def enumerate_mutations(tree, lines):
    """Mutations available on `tree`. The returned nodes belong to THAT tree —
    callers that intend to mutate must pass the tree they will unparse, or the
    rewrite lands on an object no longer reachable from the output."""
    c = Collector(lines)
    c.visit(tree)
    # Deterministic order: line, then the operator name, so two runs of this
    # tool on one commit produce the same ids and a survivor stays citable.
    return sorted(c.found, key=lambda f: (f[0], op_name(f[2], f[3])))


# ── Running ──────────────────────────────────────────────────────

def run_tests(tree_dir, targets):
    env = dict(os.environ)
    env["SDL_VIDEODRIVER"] = "dummy"
    # PYTHONDONTWRITEBYTECODE is load-bearing, not hygiene. CPython invalidates
    # a .pyc on (mtime, size), and mutants are written into the same path in
    # quick succession — an operator swap like `==` -> `!=` leaves the file byte
    # for byte the same LENGTH, so a mutant written inside the same mtime second
    # as the previous one is served the previous mutant's cached bytecode. The
    # mutation never runs, the tests pass, and it is recorded as a survivor that
    # was never actually tried. That is a fabricated finding in the one field
    # the ledger uses to decide whether a mission counts as measured.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    r = subprocess.run(
        [sys.executable, "-m", "pytest", *targets, "-q", "--tb=no", "-x",
         "-p", "no:cacheprovider"],
        cwd=tree_dir, capture_output=True, text=True, env=env,
    )
    out = (r.stdout or "") + (r.stderr or "")
    # returncode alone cannot tell "one assertion failed" from "the file did not
    # import": both are non-zero, but only the first is a killed mutant. A
    # collection error means the mutant is unrunnable, not owned.
    collected = (" passed" in out) or (" failed" in out)
    return r.returncode == 0, collected, out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", default="HEAD")
    ap.add_argument("--tests", default="")
    ap.add_argument("--mutate", default="",
                    help="source paths to mutate in full, for missions whose diff "
                         "is tests-only; defaults to the sources the diff changed")
    ap.add_argument("--max", type=int, default=25)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    files = changed_files(a.repo, a.base, a.head)
    delivered_tests = [f for f in files if f.endswith(".py") and is_test_path(f)]
    targets = a.tests.split() if a.tests.strip() else delivered_tests

    named = [p.strip().replace("\\", "/") for p in a.mutate.split() if p.strip()]
    whole_file = bool(named)
    if named:
        # Operator input, so it is checked rather than trusted. A typo'd path
        # would otherwise be skipped in silence and the sweep would report a
        # clean N/N over the files that happened to spell correctly.
        bad = [p for p in named if is_test_path(p)]
        if bad:
            print(f"g-sweep: --mutate names test file(s): {', '.join(bad)}")
            print("         Mutating tests measures whether the GAME notices a broken test,")
            print("         which is the question backwards. Name the source they claim to own.")
            return 2
        sources = named
    else:
        sources = [f for f in files if f.endswith(".py") and not is_test_path(f)]

    if not sources:
        print("g-sweep: the mission changed no non-test .py source — nothing to mutate.")
        print("         If this was a tests-only mission, name the source its tests claim")
        print("         to own:  --mutate \"gilded/agenda.py gilded/ai.py\"")
        print("         UNMEASURED. Do not record a sweep.")
        return 2
    if not targets:
        print("g-sweep: the mission delivered no test files and --tests was not given.")
        print("         UNMEASURED, and itself the finding: nothing was delivered to own the change.")
        return 2

    tmp = tempfile.mkdtemp(prefix="gsweep_")
    tree_dir = os.path.join(tmp, "tree")
    os.makedirs(tree_dir)
    try:
        ar = subprocess.run(["git", "-C", a.repo, "archive", a.head], capture_output=True)
        if ar.returncode != 0:
            print(f"g-sweep: cannot export {a.head}")
            return 2
        if subprocess.run(["tar", "-x", "-C", tree_dir], input=ar.stdout).returncode != 0:
            print(f"g-sweep: cannot unpack {a.head}")
            return 2

        print(f"g-sweep: {a.repo} {a.base}..{a.head}")
        scope = "whole file, named by --mutate" if whole_file else "added lines only"
        print(f"  mutating : {', '.join(sources)} ({scope})")
        print(f"  running  : {' '.join(targets)}")
        print()

        # Plan every mutation first, and rewrite each source once to its
        # unparsed identity form so the identity check covers every file that
        # will later be rewritten — not just the ones that happen to mutate.
        plan = []
        originals = {}
        mission_lines = {}
        for src in sources:
            path = os.path.join(tree_dir, src.replace("/", os.sep))
            if not os.path.exists(path):
                if whole_file:
                    print(f"g-sweep: --mutate names {src}, which does not exist at {a.head}.")
                    print("         UNMEASURED. Do not record a sweep.")
                    return 2
                continue
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
            originals[src] = (path, text)
            mission_lines[src] = None if whole_file else added_lines(a.repo, a.base, a.head, src)
            found = enumerate_mutations(ast.parse(text), mission_lines[src])
            # Carry the INDEX, not the node. Node objects belong to the parse
            # that produced them; a node from this planning tree is not
            # `is`-identical to anything in the fresh tree each mutant is built
            # from, so applying it would rewrite nothing and the "mutant" would
            # be the identity — reported as a survivor that was never tried.
            for idx, (lineno, _node, kind, payload) in enumerate(found):
                plan.append((src, idx, lineno, kind, payload))

        if not plan:
            where = "in any file named by --mutate" if whole_file else "on any line this mission added"
            print(f"g-sweep: no mutable expression {where}.")
            print("         UNMEASURED. Do not record a sweep.")
            return 2

        # Identity: unparse every source without mutating anything.
        for src, (path, text) in originals.items():
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(ast.unparse(ast.parse(text)))
        ok, collected, out = run_tests(tree_dir, targets)
        if not ok or not collected:
            print("g-sweep: the UNMUTATED tree is already red under unparse.")
            print("         Every mutant would die for a reason that is not the mutation,")
            print("         so this is UNMEASURED, not 15/15. Do not record a sweep.")
            print(out[-1500:])
            return 2
        print(f"  identity : green ({len(plan)} mutation(s) available)")

        if len(plan) > a.max:
            if whole_file:
                # Spread, don't truncate. A whole-file plan runs into the
                # hundreds, and the first 25 of it are the first 25 lines of the
                # first file — a sweep that would report "25/25 killed" having
                # never looked past one file's imports. Evenly spaced keeps it
                # deterministic (same commit, same ids) while covering every file
                # in proportion to how much of it is mutable.
                available = len(plan)
                step = available / a.max
                plan = [plan[int(i * step)] for i in range(a.max)]
                print(f"  capped   : {a.max} of {available} available, "
                      f"evenly spaced across every named file")
            else:
                print(f"  capped   : {len(plan)} available, running the first {a.max}")
                plan = plan[: a.max]
        print()

        killed, survived = [], []
        for src, idx, lineno, kind, payload in plan:
            mid = f"{src}:{lineno}:{op_name(kind, payload)}"
            path, text = originals[src]
            tree = ast.parse(text)
            # enumerate_mutations is a pure function of (text, lines) and sorts
            # deterministically, so index idx of a fresh collection is the same
            # mutation the plan named — but the node now belongs to `tree`.
            fresh = enumerate_mutations(tree, mission_lines[src])
            target = fresh[idx][1] if idx < len(fresh) else None
            if target is None or not apply_one(tree, target, kind, payload):
                print(f"  SKIP  {mid} (could not be applied)")
                continue
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(ast.unparse(tree))
            ok, collected, _ = run_tests(tree_dir, targets)
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(ast.unparse(ast.parse(text)))   # back to identity

            if not collected:
                print(f"  SKIP  {mid} (mutant does not import — unrunnable, not owned)")
                continue
            if ok:
                survived.append(mid)
                print(f"  LIVE  {mid}")
            else:
                killed.append(mid)
                print(f"  killed {mid}")

        total = len(killed) + len(survived)
        print()
        if total == 0:
            print("g-sweep: no mutation could be run. UNMEASURED.")
            return 2

        print(f"g-sweep: {len(killed)}/{total} killed")
        if survived:
            print()
            print("Survivors — lines this mission added that its own tests cannot tell are wrong:")
            for s in survived:
                print(f"    {s}")

        cmd = (f"python scripts/cynco-mutation-sweep.py --repo {a.repo} "
               f"--base {a.base} --head {a.head}"
               + (f' --tests "{a.tests}"' if a.tests.strip() else "")
               + (f' --mutate "{a.mutate}"' if whole_file else ""))
        # A --mutate run is AUTHORED: a human named the files, asserting the
        # mission's tests own the rules in them, so a survivor is an unmet claim
        # and the labeling rule should read it as one. Without --mutate the
        # mutation set came from the diff alone and nobody claimed anything, so
        # a survivor is a coverage finding — derived.
        kind = "authored" if whole_file else "derived"
        print()
        print("Record it with:")
        print(f'  bun scripts/cynco-ledger-sweep.mjs --mission <id> --kind {kind} \\')
        print(f'      --command "{cmd}" --killed {len(killed)} --total {total}'
              + (" \\\n      --survived " + ",".join(survived) if survived else ""))

        if a.json:
            print()
            print(json.dumps({"command": cmd, "kind": kind, "killed": len(killed),
                              "total": total, "survived": survived}))
        return 0 if not survived else 1
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
