"""Progress list widget -- step list with status icons."""
from textual.widgets import Static


class ProgressList(Static):
    """Displays a list of steps with status indicators."""

    DEFAULT_CSS = """
    ProgressList {
        height: auto;
        padding: 0 1;
    }
    """

    def __init__(self, steps: list[str] | None = None, **kwargs):
        super().__init__(**kwargs)
        self._steps: list[dict] = []
        if steps:
            for s in steps:
                self._steps.append({"text": s, "status": "pending"})

    def set_step_status(self, index: int, status: str) -> None:
        """Set status: 'pending', 'active', 'done', 'error'."""
        if 0 <= index < len(self._steps):
            self._steps[index]["status"] = status
            self._render()

    def _render(self) -> None:
        icons = {"pending": "\u25cb", "active": "\u25c9", "done": "\u2713", "error": "\u2717"}
        colors = {"pending": "dim", "active": "cyan", "done": "green", "error": "red"}
        lines = []
        for step in self._steps:
            icon = icons.get(step["status"], "?")
            color = colors.get(step["status"], "white")
            lines.append(f"  [{color}]{icon} {step['text']}[/{color}]")
        self.update("\n".join(lines) if lines else "[dim]No steps[/dim]")
