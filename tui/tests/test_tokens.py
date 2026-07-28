"""Tests for localcode_tui.tokens — reading the engine-minted capability token.

The engine refuses an unauthenticated WebSocket upgrade (401), so the TUI has to
present the bridge-scoped secret. It is written by the engine at startup to
~/.cynco/tokens.json; reading it there is what keeps launching the TUI a
zero-argument operation — no flag, no env var, no paste.
"""
import json
import pytest

from localcode_tui.tokens import bridge_token


def write_tokens(dirpath, tokens):
    path = dirpath / "tokens.json"
    path.write_text(json.dumps({"version": 1, "tokens": tokens}), encoding="utf-8")
    return path


class TestBridgeToken:
    def test_reads_the_secret_whose_scopes_include_bridge(self, tmp_path):
        write_tokens(tmp_path, [
            {"name": "tui", "scopes": ["bridge"], "secret": "a" * 64},
            {"name": "dashboard", "scopes": ["inference"], "secret": "b" * 64},
        ])
        assert bridge_token(tmp_path) == "a" * 64

    def test_ignores_entries_without_the_bridge_scope(self, tmp_path):
        """A dashboard secret opening the bridge would defeat the scope split."""
        write_tokens(tmp_path, [
            {"name": "dashboard", "scopes": ["inference"], "secret": "b" * 64},
            {"name": "admin", "scopes": ["inference", "management"], "secret": "c" * 64},
        ])
        assert bridge_token(tmp_path) is None

    def test_returns_none_when_the_file_is_absent(self, tmp_path):
        """Engine not started yet. Connect anyway and let the 401 be the error."""
        assert bridge_token(tmp_path) is None

    def test_returns_none_when_the_file_is_not_json(self, tmp_path):
        (tmp_path / "tokens.json").write_text("{not json", encoding="utf-8")
        assert bridge_token(tmp_path) is None

    def test_returns_none_when_the_shape_is_wrong(self, tmp_path):
        """Never raise out of a token read — a malformed file must not stop the
        TUI from starting and reporting a connection failure normally."""
        (tmp_path / "tokens.json").write_text('{"tokens": "nope"}', encoding="utf-8")
        assert bridge_token(tmp_path) is None

    def test_skips_a_malformed_entry_and_keeps_looking(self, tmp_path):
        write_tokens(tmp_path, [
            "not-an-object",
            {"name": "no-secret", "scopes": ["bridge"]},
            {"name": "tui", "scopes": ["bridge"], "secret": "d" * 64},
        ])
        assert bridge_token(tmp_path) == "d" * 64

    def test_defaults_to_the_cynco_home_directory(self, tmp_path, monkeypatch):
        """The zero-argument path: no caller passes a directory in production."""
        monkeypatch.setattr("pathlib.Path.home", lambda: tmp_path)
        cynco = tmp_path / ".cynco"
        cynco.mkdir()
        write_tokens(cynco, [{"name": "tui", "scopes": ["bridge"], "secret": "e" * 64}])
        assert bridge_token() == "e" * 64
