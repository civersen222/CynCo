"""File preview widget -- syntax-highlighted file viewer."""
from textual.widgets import Static


class FilePreview(Static):
    """Displays file contents with syntax highlighting."""

    DEFAULT_CSS = """
    FilePreview {
        height: 1fr;
        border: solid $accent;
        overflow-y: auto;
    }
    """

    def show_file(self, path: str, content: str = "") -> None:
        """Display a file with its path as header."""
        if not content:
            try:
                with open(path) as f:
                    content = f.read()
            except (FileNotFoundError, PermissionError) as e:
                self.update(f"[red]Cannot read {path}: {e}[/red]")
                return

        # Show path header + content
        self.update(f"[bold]{path}[/bold]\n{'\u2500' * 40}\n{content}")

    def show_diff(self, path: str, diff: str) -> None:
        """Display a diff with color coding."""
        lines = []
        for line in diff.split("\n"):
            if line.startswith("+"):
                lines.append(f"[green]{line}[/green]")
            elif line.startswith("-"):
                lines.append(f"[red]{line}[/red]")
            elif line.startswith("@"):
                lines.append(f"[cyan]{line}[/cyan]")
            else:
                lines.append(line)
        self.update(f"[bold]{path}[/bold]\n{'\u2500' * 40}\n" + "\n".join(lines))
