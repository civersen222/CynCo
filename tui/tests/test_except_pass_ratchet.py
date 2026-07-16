"""Guard: no NEW `except ...: pass` blocks in localcode_tui (2026-07-16 audit)."""
import json
import re
from pathlib import Path

TUI_ROOT = Path(__file__).resolve().parent.parent / "localcode_tui"
BASELINE_PATH = Path(__file__).resolve().parent / "except_pass_baseline.json"

PATTERN = re.compile(r"except[^\n]*:\s*\n\s*pass\b|except[^\n]*:\s*pass\b")


def current_counts() -> dict:
    counts = {}
    for path in sorted(TUI_ROOT.rglob("*.py")):
        n = len(PATTERN.findall(path.read_text(encoding="utf-8")))
        if n:
            counts[path.relative_to(TUI_ROOT).as_posix()] = n
    return counts


def test_no_new_except_pass():
    baseline = json.loads(BASELINE_PATH.read_text())
    regressions = [
        f"{f}: {n} except-pass blocks (baseline {baseline.get(f, 0)})"
        for f, n in current_counts().items()
        if n > baseline.get(f, 0)
    ]
    assert not regressions, (
        "New silent except-pass blocks — use self.log/print instead:\n" + "\n".join(regressions)
    )


def test_baseline_stays_honest():
    baseline = json.loads(BASELINE_PATH.read_text())
    counts = current_counts()
    stale = [
        f"{f}: baseline {n}, now {counts.get(f, 0)}"
        for f, n in baseline.items()
        if counts.get(f, 0) < n
    ]
    assert not stale, "Ratchet down — regenerate the baseline:\n" + "\n".join(stale)
