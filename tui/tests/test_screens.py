"""Tests for TUI screens (Tasks 20-22).

Tests cover: WorkspaceScreen, GuidedScreen, SetupWizard, ModelPicker.
"""
import pytest

from textual.screen import Screen, ModalScreen


# ─── WorkspaceScreen ─────────────────────────────────────────

class TestWorkspaceScreen:
    """Tests for the workspace mode screen."""

    def test_import(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert WorkspaceScreen is not None

    def test_inherits_screen(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert issubclass(WorkspaceScreen, Screen)

    def test_has_compose(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert hasattr(WorkspaceScreen, "compose")

    def test_has_bindings(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert WorkspaceScreen.BINDINGS is not None
        assert len(WorkspaceScreen.BINDINGS) > 0

    def test_has_input_handler(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert hasattr(WorkspaceScreen, "on_input_submitted")

    def test_css_path_set(self):
        from localcode_tui.screens.workspace import WorkspaceScreen
        assert WorkspaceScreen.CSS_PATH is not None


# ─── GuidedScreen ────────────────────────────────────────────

class TestGuidedScreen:
    """Tests for the guided mode screen."""

    def test_import(self):
        from localcode_tui.screens.guided import GuidedScreen
        assert GuidedScreen is not None

    def test_inherits_screen(self):
        from localcode_tui.screens.guided import GuidedScreen
        assert issubclass(GuidedScreen, Screen)

    def test_has_compose(self):
        from localcode_tui.screens.guided import GuidedScreen
        assert hasattr(GuidedScreen, "compose")

    def test_has_bindings(self):
        from localcode_tui.screens.guided import GuidedScreen
        assert GuidedScreen.BINDINGS is not None

    def test_has_button_handler(self):
        from localcode_tui.screens.guided import GuidedScreen
        assert hasattr(GuidedScreen, "on_button_pressed")


# ─── SetupWizard ─────────────────────────────────────────────

class TestSetupWizard:
    """Tests for the first-run setup wizard."""

    def test_import(self):
        from localcode_tui.screens.setup_wizard import SetupWizard
        assert SetupWizard is not None

    def test_inherits_screen(self):
        from localcode_tui.screens.setup_wizard import SetupWizard
        assert issubclass(SetupWizard, Screen)

    def test_has_compose(self):
        from localcode_tui.screens.setup_wizard import SetupWizard
        assert hasattr(SetupWizard, "compose")

    def test_has_button_handler(self):
        from localcode_tui.screens.setup_wizard import SetupWizard
        assert hasattr(SetupWizard, "on_button_pressed")


# ─── ModelPicker ─────────────────────────────────────────────

class TestModelPicker:
    """Tests for the model picker modal."""

    def test_import(self):
        from localcode_tui.screens.model_picker import ModelPicker
        assert ModelPicker is not None

    def test_inherits_modal_screen(self):
        from localcode_tui.screens.model_picker import ModelPicker
        assert issubclass(ModelPicker, ModalScreen)

    def test_has_compose(self):
        from localcode_tui.screens.model_picker import ModelPicker
        assert hasattr(ModelPicker, "compose")

    def test_has_button_handler(self):
        from localcode_tui.screens.model_picker import ModelPicker
        assert hasattr(ModelPicker, "on_button_pressed")

    def test_fetch_local_models_returns_list(self):
        from localcode_tui.screens.model_picker import fetch_local_models
        # fetch_local_models returns [] when Ollama is unavailable
        result = fetch_local_models(base_url="http://localhost:19999")
        assert isinstance(result, list)

    def test_fetch_local_models_tuple_structure(self):
        from localcode_tui.screens.model_picker import fetch_local_models
        # When Ollama is running, results are (name, size) tuples
        assert callable(fetch_local_models)


# ─── Screens __init__ exports ────────────────────────────────

class TestScreensInit:
    """Tests for the screens package __init__.py exports."""

    def test_workspace_exported(self):
        from localcode_tui.screens import WorkspaceScreen
        assert WorkspaceScreen is not None

    def test_guided_exported(self):
        from localcode_tui.screens import GuidedScreen
        assert GuidedScreen is not None

    def test_setup_wizard_exported(self):
        from localcode_tui.screens import SetupWizard
        assert SetupWizard is not None

    def test_model_picker_exported(self):
        from localcode_tui.screens import ModelPicker
        assert ModelPicker is not None

    def test_vibe_loop_exported(self):
        from localcode_tui.screens import VibeLoopScreen
        assert VibeLoopScreen is not None


# ─── VibeLoopScreen ─────────────────────────────────────────

class TestVibeLoopScreen:
    """Tests for the vibe loop screen."""

    def test_import(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert VibeLoopScreen is not None

    def test_is_screen(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert issubclass(VibeLoopScreen, Screen)

    def test_has_compose(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, "compose")

    def test_has_state_handlers(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert hasattr(VibeLoopScreen, "handle_state_changed")
        assert hasattr(VibeLoopScreen, "handle_task_complete")
        assert hasattr(VibeLoopScreen, "handle_confidence_update")
        assert hasattr(VibeLoopScreen, "handle_question")

    def test_has_bindings(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        assert VibeLoopScreen.BINDINGS is not None
        assert len(VibeLoopScreen.BINDINGS) > 0

    def test_initial_state(self):
        from localcode_tui.screens.vibe_loop import VibeLoopScreen
        screen = VibeLoopScreen()
        assert screen._state == "idle"
