"""The TUI read its own files with whatever codec the platform happened to pick.

Measured 2026-07-31, on the platform this project runs on. `python3 -c
"import locale; print(locale.getpreferredencoding())"` answers cp1252, and the
training pipeline had already died on it:

    UnicodeDecodeError: 'charmap' codec can't decode byte 0x90 in position 1348

`open(p)` with no `encoding=` takes that codec. Every file the TUI reads is
UTF-8 — a config a human edited, a session state file the engine wrote, a
source file from the user's project. A single non-ASCII byte in any of them
raises, and none of the three call sites catch UnicodeDecodeError:

  * `load_config` — an accented path or a model name with a dash the editor
    smart-quoted takes the whole TUI down at startup.
  * `context_sidebar.show_file` — catches FileNotFoundError and PermissionError
    only, so previewing an ordinary source file with an em dash in a comment
    crashes the widget. CynCo's own sources are full of them.

The preview is the one place `errors="replace"` is right rather than strict: it
displays and does not persist, so a mangled glyph beats a dead TUI. Everywhere
the value is kept or written back, strict is right, because silent corruption
is worse than a crash.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from localcode_tui.config import Config, load_config, save_config
from localcode_tui.widgets.context_sidebar import ContextSidebar

# An em dash, an accented name, and a CJK char: the three ways this shows up in
# a real project. 0x2014 is the byte the training pipeline actually died on.
NON_ASCII = "modèle — 日本語"


def test_load_config_reads_a_utf8_file(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text(f'model: "{NON_ASCII}"\ntemperature: 0.5\n', encoding="utf-8")
    cfg = load_config(p)
    assert cfg.model == NON_ASCII


def test_config_round_trips_non_ascii(tmp_path):
    # Save then load. If the writer escapes and the reader unescapes, this
    # passes for a reason worth knowing; if either uses the platform codec on a
    # non-ASCII value, it does not.
    p = tmp_path / "config.yaml"
    cfg = Config()
    cfg.model = NON_ASCII
    save_config(cfg, p)
    assert load_config(p).model == NON_ASCII


def test_preview_reads_a_utf8_source_file(tmp_path):
    src = tmp_path / "sample.py"
    src.write_text(f"# {NON_ASCII}\nx = 1\n", encoding="utf-8")

    seen = {}
    sidebar = ContextSidebar.__new__(ContextSidebar)
    sidebar.add_file = lambda p: None
    sidebar.show_preview = lambda p, c: seen.update(path=p, content=c)
    sidebar.update = lambda msg: seen.update(error=msg)

    ContextSidebar.show_file(sidebar, str(src))

    assert "error" not in seen, seen.get("error")
    # Asserting only that it did not crash would be a test that cannot fail:
    # cp1252 is a single-byte codec that decodes almost anything, so the
    # pre-fix behaviour is silent mojibake, not an exception. The comment has
    # to come back as it was written.
    assert NON_ASCII in seen["content"]


def test_preview_survives_a_file_that_is_not_utf8_at_all(tmp_path):
    # A latin-1 source file in someone's project must not kill the widget.
    # This is why the preview replaces rather than raises.
    src = tmp_path / "latin1.py"
    src.write_bytes(b"# caf\xe9\nx = 1\n")

    seen = {}
    sidebar = ContextSidebar.__new__(ContextSidebar)
    sidebar.add_file = lambda p: None
    sidebar.show_preview = lambda p, c: seen.update(path=p, content=c)
    sidebar.update = lambda msg: seen.update(error=msg)

    ContextSidebar.show_file(sidebar, str(src))

    assert "error" not in seen, seen.get("error")
    assert "x = 1" in seen["content"]
    # The undecodable byte becomes U+FFFD rather than an exception. Naming the
    # character is what makes this a test of `errors="replace"` and not just of
    # "it returned something".
    assert "caf\ufffd" in seen["content"]
