"""Project entry widget — shows context-aware entry points for the vibe loop."""
from textual.widgets import Static


class ProjectEntry(Static):
    """Context-aware project entry: new, existing, or returning."""

    DEFAULT_CSS = """
    ProjectEntry {
        height: auto;
        padding: 1 2;
        margin: 1 0;
        border: heavy $accent;
        background: $surface;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._project_name = ""
        self._file_count = 0
        self._languages = []
        self._summary = ""
        self._done_items = []
        self._next_suggestion = ""
        self._mode = "new"

    def set_new_project(self) -> None:
        self._mode = "new"
        self.update(
            "[bold]What would you like to build?[/bold]\n\n"
            "Describe your idea in a sentence or two.\n"
            "I'll ask questions to understand what you want, then start building."
        )

    def set_existing_project(self, name: str, file_count: int, languages: list, summary: str) -> None:
        self._mode = "existing"
        self._project_name = name
        self._file_count = file_count
        self._languages = languages
        self._summary = summary
        lang_str = ", ".join(languages) if languages else "unknown"
        self.update(
            f"[bold]I found an existing project here.[/bold]\n\n"
            f"\U0001f4c1 [cyan]{name}/[/cyan] \u2014 {lang_str} ({file_count} files)\n"
            f"{summary}"
        )

    def set_returning(self, done: list, next_suggestion: str) -> None:
        self._mode = "returning"
        self._done_items = done
        self._next_suggestion = next_suggestion
        done_lines = "\n".join(f"  [green]\u2713[/green] {item}" for item in done)
        self.update(
            f"[bold]Welcome back![/bold] Last time we:\n\n"
            f"{done_lines}\n\n"
            f"[bold]Next up:[/bold] {next_suggestion}"
        )
