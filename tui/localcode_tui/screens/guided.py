"""Guided mode -- beginner-friendly vibe loop interface."""
from textual.screen import Screen
from textual.widgets import Static, Button, Footer
from textual.containers import Vertical, Center

from ..widgets import ContextBar


class GuidedScreen(Screen):
    """Guided coding mode — routes to the vibe loop."""

    CSS_PATH = "../styles/guided.tcss"

    BINDINGS = [
        ("ctrl+w", "go_workspace", "Workspace Mode"),
        ("escape", "app.pop_screen", "Back"),
    ]

    def compose(self):
        yield ContextBar(id="context-bar")
        yield Center(
            Vertical(
                Static("[bold]Welcome to LocalCode![/bold]\n\nWhat would you like to do?", id="welcome"),
                Button("Start a new project", variant="primary", id="new-project"),
                Button("Work on existing code", variant="primary", id="existing-project"),
                Button("Fix a bug", variant="warning", id="fix-bug"),
                Button("Learn something", variant="default", id="learn"),
                Button("Switch to workspace mode (Ctrl+W)", variant="default", id="workspace"),
                id="menu",
            ),
            id="center-container",
        )
        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "workspace":
            self.action_go_workspace()
        elif event.button.id == "new-project":
            self._go_new_project()
        elif event.button.id == "existing-project":
            self._go_vibe("continue")
        elif event.button.id == "fix-bug":
            self._go_vibe("fix")
        elif event.button.id == "learn":
            self._go_vibe("explain")

    def _go_new_project(self) -> None:
        """New project → ProjectWizard (research, brainstorm, design, plan) → VibeLoopScreen."""
        from .project_wizard import ProjectWizard
        def on_project_dismiss(result) -> None:
            if result and isinstance(result, list):
                from .vibe_loop import VibeLoopScreen
                self.app.switch_screen(VibeLoopScreen(phases=result))
        self.app.push_screen(ProjectWizard(), on_project_dismiss)

    def _go_vibe(self, mode: str) -> None:
        """Switch to the vibe loop screen with the given mode."""
        from .vibe_loop import VibeLoopScreen
        screen = VibeLoopScreen()
        self.app.switch_screen(screen)

    def action_go_workspace(self) -> None:
        from .workspace import WorkspaceScreen
        self.app.switch_screen(WorkspaceScreen())
