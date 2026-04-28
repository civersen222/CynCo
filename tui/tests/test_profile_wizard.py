import pytest
from localcode_tui.screens.profile_wizard_presets import (
    USE_CASES,
    get_preset,
    generate_profile_yaml,
    WizardState,
)


class TestUseCases:
    def test_use_cases_has_four_entries(self):
        assert len(USE_CASES) == 4

    def test_each_use_case_has_required_keys(self):
        required = {"id", "label", "description", "temperature", "max_output_tokens",
                     "system_prompt_hint", "suggested_tools", "explanation"}
        for uc in USE_CASES:
            missing = required - set(uc.keys())
            assert not missing, f"Use case '{uc['id']}' missing: {missing}"

    def test_coding_preset_values(self):
        preset = get_preset("coding")
        assert preset is not None
        assert preset["temperature"] <= 0.5  # Coding should be precise
        assert "Edit" in preset["suggested_tools"]

    def test_writing_preset_has_higher_temperature(self):
        preset = get_preset("writing")
        assert preset is not None
        assert preset["temperature"] >= 0.7

    def test_custom_preset_is_neutral(self):
        preset = get_preset("custom")
        assert preset is not None

    def test_unknown_preset_returns_none(self):
        assert get_preset("bogus") is None

    def test_each_preset_has_plain_language_explanation(self):
        for uc in USE_CASES:
            assert len(uc["explanation"]) > 20, \
                f"Use case '{uc['id']}' needs a real explanation, not '{uc['explanation']}'"


class TestWizardState:
    def test_default_state(self):
        state = WizardState()
        assert state.step == 0
        assert state.use_case is None
        assert state.model_name == ""
        assert state.profile_name == ""

    def test_state_tracks_all_wizard_fields(self):
        state = WizardState(
            use_case="coding",
            model_name="qwen3:8b",
            temperature=0.3,
            max_output_tokens=16384,
            context_length=32768,
            system_prompt_lines=["Be concise.", "Use tools."],
            tools_allowed=["Read", "Edit"],
            tools_denied=["Bash"],
            profile_name="my-coder",
        )
        assert state.use_case == "coding"
        assert state.profile_name == "my-coder"


class TestGenerateProfileYaml:
    def test_generates_valid_yaml_with_name(self):
        state = WizardState(
            use_case="coding",
            model_name="qwen3:8b",
            temperature=0.3,
            max_output_tokens=16384,
            context_length=32768,
            profile_name="my-coder",
        )
        yaml_str = generate_profile_yaml(state)
        assert "name: my-coder" in yaml_str
        assert "model: qwen3:8b" in yaml_str
        assert "temperature: 0.3" in yaml_str

    def test_includes_system_prompt_when_present(self):
        state = WizardState(
            profile_name="test",
            model_name="qwen3:8b",
            system_prompt_lines=["Be helpful.", "Explain your reasoning."],
        )
        yaml_str = generate_profile_yaml(state)
        assert "system_prompt_append" in yaml_str
        assert "Be helpful." in yaml_str

    def test_includes_tools_when_present(self):
        state = WizardState(
            profile_name="test",
            model_name="qwen3:8b",
            tools_allowed=["Read", "Edit"],
            tools_denied=["Bash"],
        )
        yaml_str = generate_profile_yaml(state)
        assert "tools:" in yaml_str
        assert "Read" in yaml_str
        assert "Bash" in yaml_str

    def test_omits_empty_sections(self):
        state = WizardState(
            profile_name="minimal",
            model_name="qwen3:8b",
        )
        yaml_str = generate_profile_yaml(state)
        assert "system_prompt_append" not in yaml_str
        assert "tools:" not in yaml_str

    def test_yaml_is_parseable(self):
        import yaml
        state = WizardState(
            use_case="coding",
            model_name="qwen3:8b",
            temperature=0.3,
            max_output_tokens=16384,
            context_length=32768,
            profile_name="test-profile",
            system_prompt_lines=["Be concise."],
            tools_allowed=["Read"],
        )
        yaml_str = generate_profile_yaml(state)
        parsed = yaml.safe_load(yaml_str)
        assert parsed["name"] == "test-profile"
        assert parsed["temperature"] == 0.3


class TestExpertiseLevel:
    def test_wizard_state_has_expertise_field(self):
        from localcode_tui.screens.profile_wizard_presets import WizardState
        state = WizardState()
        assert state.expertise == "advanced"

    def test_wizard_state_accepts_all_levels(self):
        from localcode_tui.screens.profile_wizard_presets import WizardState
        for level in ("beginner", "intermediate", "advanced"):
            state = WizardState(expertise=level)
            assert state.expertise == level

    def test_generate_yaml_includes_expertise(self):
        from localcode_tui.screens.profile_wizard_presets import WizardState, generate_profile_yaml
        state = WizardState(profile_name="test", model_name="qwen3:8b", expertise="beginner")
        yaml_str = generate_profile_yaml(state)
        assert "expertise: beginner" in yaml_str

    def test_generate_yaml_omits_expertise_when_advanced(self):
        from localcode_tui.screens.profile_wizard_presets import WizardState, generate_profile_yaml
        state = WizardState(profile_name="test", model_name="qwen3:8b", expertise="advanced")
        yaml_str = generate_profile_yaml(state)
        assert "expertise" not in yaml_str

    def test_presets_set_expertise_based_on_use_case(self):
        from localcode_tui.screens.profile_wizard_presets import USE_CASES
        for uc in USE_CASES:
            assert "default_expertise" in uc, f"Use case '{uc['id']}' missing default_expertise"
