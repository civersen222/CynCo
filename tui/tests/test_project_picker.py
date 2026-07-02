"""Tests for the project picker engine-launch wiring.

Regression coverage for the 2026-07-02 live-session breakage: the picker
forwarded the TUI's own config.yml model as LOCALCODE_MODEL, letting a stale
TUI config silently override the engine profile.
"""
from dataclasses import dataclass

from localcode_tui.screens.project_picker import (
    build_engine_env,
    read_engine_log_tail,
)


@dataclass
class FakeConfig:
    model: str = "stale-model:latest"
    context_length: int = 2048


class TestBuildEngineEnv:
    def test_does_not_forward_tui_config_model(self):
        """The TUI's config.yml model must never become LOCALCODE_MODEL."""
        env = build_engine_env({"PATH": "/usr/bin"}, FakeConfig())
        assert "LOCALCODE_MODEL" not in env

    def test_explicit_env_override_passes_through(self):
        env = build_engine_env(
            {"LOCALCODE_MODEL": "user-choice", "PATH": "/usr/bin"}, FakeConfig()
        )
        assert env["LOCALCODE_MODEL"] == "user-choice"

    def test_explicit_context_length_passes_through(self):
        env = build_engine_env({"LOCALCODE_CONTEXT_LENGTH": "65536"}, FakeConfig())
        assert env["LOCALCODE_CONTEXT_LENGTH"] == "65536"

    def test_base_env_not_mutated(self):
        base = {"PATH": "/usr/bin"}
        env = build_engine_env(base, FakeConfig())
        env["EXTRA"] = "x"
        assert "EXTRA" not in base

    def test_works_without_app_config(self):
        env = build_engine_env({"PATH": "/usr/bin"}, None)
        assert env == {"PATH": "/usr/bin"}


class TestReadEngineLogTail:
    def test_returns_last_lines(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("\n".join(f"line {i}" for i in range(20)) + "\n")
        tail = read_engine_log_tail(str(log), max_lines=3)
        assert tail == "line 17\nline 18\nline 19"

    def test_short_file_returned_whole(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("only line\n")
        assert read_engine_log_tail(str(log)) == "only line"

    def test_missing_file(self, tmp_path):
        assert read_engine_log_tail(str(tmp_path / "nope.log")) == "(no engine log found)"

    def test_empty_file(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("")
        assert read_engine_log_tail(str(log)) == "(engine log is empty)"
