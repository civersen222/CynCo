import pytest
from localcode_tui.screens.settings import (
    SettingsScreen,
    build_section_fields,
    SECTION_ORDER,
    SECTION_LABELS,
    build_initial_values,
    compute_dirty_fields,
    get_restart_fields,
)


class TestSettingsScreenStructure:
    def test_section_order_has_all_known_sections(self):
        expected = ["model", "engine", "tools", "context", "ui", "profiles"]
        assert SECTION_ORDER == expected

    def test_section_labels_maps_all_sections(self):
        for section in SECTION_ORDER:
            assert section in SECTION_LABELS
            assert isinstance(SECTION_LABELS[section], str)

    def test_build_section_fields_returns_schema_fields_for_section(self):
        fields = build_section_fields("engine")
        names = [f["name"] for f in fields]
        assert "temperature" in names
        assert "max_output_tokens" in names
        assert "timeout" in names
        assert "base_url" in names

    def test_build_section_fields_excludes_other_sections(self):
        fields = build_section_fields("engine")
        names = [f["name"] for f in fields]
        assert "model" not in names
        assert "theme" not in names

    def test_build_section_fields_empty_for_profiles(self):
        fields = build_section_fields("profiles")
        assert fields == []

    def test_build_section_fields_empty_for_unknown(self):
        fields = build_section_fields("bogus")
        assert fields == []


class TestDirtyTracking:
    def test_initial_values_dict(self):
        values = build_initial_values()
        assert "temperature" in values
        assert values["temperature"] == 0.7
        assert values["theme"] == "dark"

    def test_compute_dirty_fields(self):
        original = {"temperature": 0.7, "timeout": 300000}
        current = {"temperature": 0.5, "timeout": 300000}
        dirty = compute_dirty_fields(original, current)
        assert dirty == {"temperature": 0.5}

    def test_compute_dirty_fields_empty_when_unchanged(self):
        original = {"temperature": 0.7}
        current = {"temperature": 0.7}
        dirty = compute_dirty_fields(original, current)
        assert dirty == {}


class TestApplyModeAnnotation:
    def test_restart_fields_identified(self):
        restart = get_restart_fields()
        assert "base_url" in restart
        assert "tier" in restart
        assert "temperature" not in restart
