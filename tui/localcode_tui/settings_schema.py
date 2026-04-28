"""Settings schema — single source of truth for field metadata.

Each field declares its name, type, apply mode (live vs restart),
default value, description, section, and validator. The Settings UI
(Phase C.2) reads this schema to build its form data-driven.
"""
from __future__ import annotations


def _validate_float_range(min_v: float, max_v: float):
    def validator(value):
        if not isinstance(value, (int, float)):
            return f"Must be a number, got {type(value).__name__}"
        if value < min_v or value > max_v:
            return f"Must be between {min_v} and {max_v}"
        return None
    return validator


def _validate_int_range(min_v: int, max_v: int):
    def validator(value):
        if not isinstance(value, int):
            return f"Must be an integer, got {type(value).__name__}"
        if value < min_v or value > max_v:
            return f"Must be between {min_v} and {max_v}"
        return None
    return validator


def _validate_enum(*choices):
    def validator(value):
        if value not in choices:
            return f"Must be one of: {', '.join(str(c) for c in choices)}"
        return None
    return validator


def _validate_string(value):
    if not isinstance(value, str):
        return f"Must be a string, got {type(value).__name__}"
    return None


def _validate_bool(value):
    if not isinstance(value, bool):
        return f"Must be a boolean, got {type(value).__name__}"
    return None


SETTINGS_SCHEMA: list[dict] = [
    # ── Model section ──
    {
        "name": "model",
        "type": "string",
        "apply_mode": "live",
        "default": "",
        "description": "Ollama model name (e.g. qwen3:8b)",
        "section": "model",
        "validator": _validate_string,
    },
    {
        "name": "tier",
        "type": "enum",
        "apply_mode": "restart",
        "default": "auto",
        "description": "Model tier override",
        "section": "model",
        "choices": ["auto", "basic", "standard", "advanced"],
        "validator": _validate_enum("auto", "basic", "standard", "advanced"),
    },
    {
        "name": "expertise",
        "type": "enum",
        "apply_mode": "live",
        "default": "advanced",
        "description": "Your coding comfort level — controls guidance, explanations, and safety",
        "section": "model",
        "choices": ["beginner", "intermediate", "advanced"],
        "validator": _validate_enum("beginner", "intermediate", "advanced"),
    },
    # ── Engine section ──
    {
        "name": "temperature",
        "type": "float",
        "apply_mode": "live",
        "default": 0.7,
        "description": "Sampling temperature (0.0–2.0)",
        "section": "engine",
        "validator": _validate_float_range(0.0, 2.0),
    },
    {
        "name": "max_output_tokens",
        "type": "int",
        "apply_mode": "live",
        "default": 8192,
        "description": "Maximum response length in tokens",
        "section": "engine",
        "validator": _validate_int_range(1, 128000),
    },
    {
        "name": "timeout",
        "type": "int",
        "apply_mode": "live",
        "default": 300000,
        "description": "Request timeout in milliseconds",
        "section": "engine",
        "validator": _validate_int_range(1000, 600000),
    },
    {
        "name": "base_url",
        "type": "string",
        "apply_mode": "restart",
        "default": "http://localhost:11434",
        "description": "Ollama server URL",
        "section": "engine",
        "validator": _validate_string,
    },
    # ── Context section ──
    {
        "name": "context_length",
        "type": "int",
        "apply_mode": "live",
        "default": 32768,
        "description": "Override context window size",
        "section": "context",
        "validator": _validate_int_range(1024, 2097152),
    },
    {
        "name": "warning_threshold",
        "type": "float",
        "apply_mode": "live",
        "default": 0.4,
        "description": "Context utilization warning threshold (0.0–1.0)",
        "section": "context",
        "validator": _validate_float_range(0.0, 1.0),
    },
    {
        "name": "hard_limit",
        "type": "float",
        "apply_mode": "live",
        "default": 0.8,
        "description": "Context utilization hard limit (0.0–1.0)",
        "section": "context",
        "validator": _validate_float_range(0.0, 1.0),
    },
    # ── UI section ──
    {
        "name": "theme",
        "type": "enum",
        "apply_mode": "live",
        "default": "dark",
        "description": "UI color theme",
        "section": "ui",
        "choices": ["dark", "light"],
        "validator": _validate_enum("dark", "light"),
    },
    {
        "name": "default_mode",
        "type": "enum",
        "apply_mode": "live",
        "default": "guided",
        "description": "Default screen mode on launch",
        "section": "ui",
        "choices": ["guided", "workspace"],
        "validator": _validate_enum("guided", "workspace"),
    },
    {
        "name": "show_token_count",
        "type": "bool",
        "apply_mode": "live",
        "default": True,
        "description": "Show token count in context bar",
        "section": "ui",
        "validator": _validate_bool,
    },
    {
        "name": "show_context_bar",
        "type": "bool",
        "apply_mode": "live",
        "default": True,
        "description": "Show context utilization bar",
        "section": "ui",
        "validator": _validate_bool,
    },
]


def get_field(name: str) -> dict | None:
    """Look up a field definition by name."""
    for field in SETTINGS_SCHEMA:
        if field["name"] == name:
            return field
    return None


def validate_field(name: str, value) -> str | None:
    """Validate a value for a named field. Returns None if valid, error string if not."""
    field = get_field(name)
    if field is None:
        return f"Unknown field: {name}"
    return field["validator"](value)
