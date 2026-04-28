"""Tests for localcode_tui.config module."""
import pytest
from pathlib import Path
from localcode_tui.config import (
    Config,
    UIConfig,
    ContextManagementConfig,
    load_config,
    save_config,
)


class TestConfigDefaults:
    def test_config_has_defaults(self):
        c = Config()
        assert c.model == ""
        assert c.base_url == "http://localhost:11434"
        assert c.temperature == 0.7
        assert c.max_output_tokens == 4096
        assert c.context_length == 32768
        assert "5433" in c.database_url

    def test_ui_config_defaults(self):
        ui = UIConfig()
        assert ui.default_mode == "guided"
        assert ui.theme == "dark"
        assert ui.show_token_count is True
        assert ui.show_context_bar is True

    def test_context_management_defaults(self):
        cm = ContextManagementConfig()
        assert cm.warning_threshold == 0.4
        assert cm.hard_limit == 0.8


class TestLoadConfig:
    def test_load_returns_defaults_when_file_missing(self, tmp_path):
        config = load_config(tmp_path / "nonexistent.yml")
        assert config.model == ""
        assert config.base_url == "http://localhost:11434"

    def test_load_from_file(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config_file.write_text(
            "model: llama3\n"
            "base_url: http://localhost:8080\n"
            "temperature: 0.5\n"
            "context_length: 8192\n"
        )
        config = load_config(config_file)
        assert config.model == "llama3"
        assert config.base_url == "http://localhost:8080"
        assert config.temperature == 0.5
        assert config.context_length == 8192

    def test_load_with_ui_section(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config_file.write_text(
            "ui:\n"
            "  default_mode: workspace\n"
            "  theme: light\n"
            "  show_token_count: false\n"
        )
        config = load_config(config_file)
        assert config.ui.default_mode == "workspace"
        assert config.ui.theme == "light"
        assert config.ui.show_token_count is False

    def test_load_with_context_management(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config_file.write_text(
            "context_management:\n"
            "  warning_threshold: 0.5\n"
            "  hard_limit: 0.9\n"
        )
        config = load_config(config_file)
        assert config.context_management.warning_threshold == 0.5
        assert config.context_management.hard_limit == 0.9

    def test_load_empty_file(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config_file.write_text("")
        config = load_config(config_file)
        assert config.model == ""  # Should get defaults


class TestSaveConfig:
    def test_save_and_reload(self, tmp_path):
        config_file = tmp_path / "sub" / "config.yml"
        config = Config(model="qwen2", temperature=0.3)
        save_config(config, config_file)
        assert config_file.exists()

        reloaded = load_config(config_file)
        assert reloaded.model == "qwen2"
        assert reloaded.temperature == 0.3

    def test_save_creates_parent_dirs(self, tmp_path):
        config_file = tmp_path / "a" / "b" / "c" / "config.yml"
        save_config(Config(), config_file)
        assert config_file.exists()

    def test_save_preserves_ui(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config = Config()
        config.ui.theme = "light"
        config.ui.default_mode = "workspace"
        save_config(config, config_file)

        reloaded = load_config(config_file)
        assert reloaded.ui.theme == "light"
        assert reloaded.ui.default_mode == "workspace"

    def test_save_preserves_context_management(self, tmp_path):
        config_file = tmp_path / "config.yml"
        config = Config()
        config.context_management.warning_threshold = 0.6
        config.context_management.hard_limit = 0.95
        save_config(config, config_file)

        reloaded = load_config(config_file)
        assert reloaded.context_management.warning_threshold == 0.6
        assert reloaded.context_management.hard_limit == 0.95
