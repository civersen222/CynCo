"""Diff view widget -- color-coded diff display."""
from textual.widgets import Static


class DiffView(Static):
    """Displays a unified diff with color coding."""

    DEFAULT_CSS = """
    DiffView {
        height: auto;
        max-height: 20;
        border: solid $accent;
        overflow-y: auto;
    }
    """

    def show_diff(self, diff_text: str) -> None:
        lines = []
        for line in diff_text.split("\n"):
            if line.startswith("+++") or line.startswith("---"):
                lines.append(f"[bold]{line}[/bold]")
            elif line.startswith("+"):
                lines.append(f"[green]{line}[/green]")
            elif line.startswith("-"):
                lines.append(f"[red]{line}[/red]")
            elif line.startswith("@@"):
                lines.append(f"[cyan]{line}[/cyan]")
            else:
                lines.append(f"[dim]{line}[/dim]")
        self.update("\n".join(lines))
