import pytest
from localcode_tui.settings_schema import SETTINGS_SCHEMA, get_field, validate_field


class TestSettingsSchema:
    def test_schema_is_a_list(self):
        assert isinstance(SETTINGS_SCHEMA, list)
        assert len(SETTINGS_SCHEMA) > 0

    def test_each_field_has_required_keys(self):
        required_keys = {"name", "type", "apply_mode", "default", "description", "section"}
        for field in SETTINGS_SCHEMA:
            missing = required_keys - set(field.keys())
            assert not missing, f"Field '{field.get('name', '?')}' missing keys: {missing}"

    def test_apply_mode_values(self):
        valid_modes = {"live", "restart"}
        for field in SETTINGS_SCHEMA:
            assert field["apply_mode"] in valid_modes, \
                f"Field '{field['name']}' has invalid apply_mode: {field['apply_mode']}"

    def test_sections_are_known(self):
        known_sections = {"model", "engine", "tools", "context", "ui"}
        for field in SETTINGS_SCHEMA:
            assert field["section"] in known_sections, \
                f"Field '{field['name']}' has unknown section: {field['section']}"


class TestGetField:
    def test_get_existing_field(self):
        field = get_field("temperature")
        assert field is not None
        assert field["name"] == "temperature"

    def test_get_nonexistent_field(self):
        assert get_field("nonexistent") is None

    def test_expertise_field_exists(self):
        from localcode_tui.settings_schema import get_field
        field = get_field("expertise")
        assert field is not None
        assert field["type"] == "enum"
        assert field["apply_mode"] == "live"
        assert "beginner" in field["choices"]


class TestValidateField:
    def test_valid_temperature(self):
        assert validate_field("temperature", 0.7) is None

    def test_invalid_temperature_too_high(self):
        error = validate_field("temperature", 5.0)
        assert error is not None
        assert "between" in error.lower() or "range" in error.lower()

    def test_invalid_temperature_wrong_type(self):
        error = validate_field("temperature", "hot")
        assert error is not None

    def test_valid_max_output_tokens(self):
        assert validate_field("max_output_tokens", 16384) is None

    def test_invalid_max_output_tokens(self):
        error = validate_field("max_output_tokens", -1)
        assert error is not None

    def test_valid_timeout(self):
        assert validate_field("timeout", 120000) is None

    def test_valid_theme(self):
        assert validate_field("theme", "dark") is None

    def test_invalid_theme(self):
        error = validate_field("theme", "rainbow")
        assert error is not None

    def test_unknown_field(self):
        error = validate_field("bogus", "anything")
        assert error is not None

    def test_valid_expertise(self):
        assert validate_field("expertise", "beginner") is None
        assert validate_field("expertise", "intermediate") is None
        assert validate_field("expertise", "advanced") is None

    def test_invalid_expertise(self):
        error = validate_field("expertise", "expert")
        assert error is not None
