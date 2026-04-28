"""Configuration management for LocalCode TUI.

Reads/writes ~/.cynco/config.yml.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import yaml


DEFAULT_CONFIG_PATH = Path.home() / ".cynco" / "config.yml"


@dataclass
class UIConfig:
    default_mode: str = "guided"  # "guided" or "workspace"
    theme: str = "dark"
    show_token_count: bool = True
    show_context_bar: bool = True


@dataclass
class ContextManagementConfig:
    warning_threshold: float = 0.4
    hard_limit: float = 0.8


@dataclass
class Config:
    model: str = ""
    base_url: str = "http://localhost:11434"
    temperature: float = 0.7
    max_output_tokens: int = 4096
    context_length: int = 32768
    database_url: str = "postgresql://localcode:localcode_dev@localhost:5433/localcode"
    expertise: str = "advanced"
    ui: UIConfig = field(default_factory=UIConfig)
    context_management: ContextManagementConfig = field(default_factory=ContextManagementConfig)


def load_config(path: Optional[Path] = None) -> Config:
    """Load config from YAML file. Returns defaults if file doesn't exist."""
    config_path = path or DEFAULT_CONFIG_PATH
    if not config_path.exists():
        return Config()

    with open(config_path) as f:
        data = yaml.safe_load(f) or {}

    config = Config()
    config.model = data.get("model", config.model)
    config.base_url = data.get("base_url", config.base_url)
    config.temperature = data.get("temperature", config.temperature)
    config.max_output_tokens = data.get("max_output_tokens", config.max_output_tokens)
    config.context_length = data.get("context_length", config.context_length)
    config.database_url = data.get("database_url", config.database_url)
    config.expertise = data.get("expertise", config.expertise)

    ui_data = data.get("ui", {})
    config.ui = UIConfig(
        default_mode=ui_data.get("default_mode", "guided"),
        theme=ui_data.get("theme", "dark"),
        show_token_count=ui_data.get("show_token_count", True),
        show_context_bar=ui_data.get("show_context_bar", True),
    )

    cm_data = data.get("context_management", {})
    config.context_management = ContextManagementConfig(
        warning_threshold=cm_data.get("warning_threshold", 0.4),
        hard_limit=cm_data.get("hard_limit", 0.8),
    )

    return config


def save_config(config: Config, path: Optional[Path] = None) -> None:
    """Save config to YAML file."""
    config_path = path or DEFAULT_CONFIG_PATH
    config_path.parent.mkdir(parents=True, exist_ok=True)

    data = {
        "model": config.model,
        "base_url": config.base_url,
        "temperature": config.temperature,
        "max_output_tokens": config.max_output_tokens,
        "context_length": config.context_length,
        "database_url": config.database_url,
        "expertise": config.expertise,
        "ui": {
            "default_mode": config.ui.default_mode,
            "theme": config.ui.theme,
            "show_token_count": config.ui.show_token_count,
            "show_context_bar": config.ui.show_context_bar,
        },
        "context_management": {
            "warning_threshold": config.context_management.warning_threshold,
            "hard_limit": config.context_management.hard_limit,
        },
    }

    with open(config_path, "w") as f:
        yaml.dump(data, f, default_flow_style=False, sort_keys=False)
