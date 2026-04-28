"""Task completion card — shows results in plain language with action buttons."""
from textual.widgets import Static


class CompletionCard(Static):
    """Displays task completion with analogy explanation."""

    DEFAULT_CSS = """
    CompletionCard {
        height: auto;
        padding: 1 2;
        margin: 1 0;
        border: heavy $accent;
        background: $surface;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._title = ""
        self._analogy = ""
        self._files_changed = []
        self._suggestion = ""
        self._show_details = False

    def set_completion(self, title: str, analogy: str, files_changed: list,
                       suggestion: str, preview_path: str | None = None) -> None:
        self._title = title
        self._analogy = analogy
        self._files_changed = files_changed
        self._suggestion = suggestion
        self._render_card()

    def _render_card(self) -> None:
        lines = [
            f"[bold green]\u2713 {self._title} Complete[/bold green]",
            "",
            self._analogy,
            "",
        ]
        if self._show_details and self._files_changed:
            lines.append("[bold]Files changed:[/bold]")
            for f in self._files_changed:
                lines.append(f"  {f}")
            lines.append("")
        elif self._files_changed:
            lines.append(f"[dim]\u25b8 Show technical details ({len(self._files_changed)} files)[/dim]")
            lines.append("")
        if self._suggestion:
            lines.append("[bold]What I'd suggest next:[/bold]")
            lines.append(f"[italic]\"{self._suggestion}\"[/italic]")
        self.update("\n".join(lines))

    def toggle_details(self) -> None:
        self._show_details = not self._show_details
        self._render_card()
