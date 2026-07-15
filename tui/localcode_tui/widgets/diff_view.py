"""Diff view widget — renders a structured file.diff event (Phase 6).

Fed by the engine's `file.diff` event (hunks of add/del/context lines). Provides
`render_plain()` as a test seam and `copy_text()` for the `/copy` handler.
"""
from __future__ import annotations
from rich.markup import escape
from textual.widgets import Static


class DiffView(Static):
    """Renders a structured diff (path + hunks) with colored +/-/context lines."""

    DEFAULT_CSS = """
    DiffView {
        height: auto;
        padding: 0 1;
        margin: 1 0;
        border: round $accent;
        background: $surface;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._path = ""
        self._change_type = "modify"
        self._hunks: list = []

    def set_diff(self, path: str, change_type: str, hunks: list) -> None:
        """Store a diff and re-render the widget."""
        self._path = path or ""
        self._change_type = change_type or "modify"
        self._hunks = hunks or []
        try:
            self.update(self._render_markup())
        except Exception:
            # Not mounted (unit test) — render_plain()/copy_text() still work.
            pass

    def _iter_lines(self):
        """Yield (kind, text) for every line across all hunks."""
        for hunk in self._hunks:
            for line in hunk.get("lines", []):
                yield line.get("kind", "context"), line.get("text", "")

    def render_plain(self) -> str:
        """Plain-text (no markup) rendering — test seam and copy source."""
        out = [f"{self._change_type}: {self._path}"]
        for kind, text in self._iter_lines():
            prefix = "+" if kind == "add" else "-" if kind == "del" else " "
            out.append(f"{prefix}{text}")
        return "\n".join(out)

    def copy_text(self) -> str:
        """Unified-diff-ish text for the /copy handler."""
        return self.render_plain()

    def _render_markup(self) -> str:
        """Rich-markup rendering with colored diff lines."""
        lines = [f"[bold]{escape(self._change_type)}: {escape(self._path)}[/bold]"]
        for kind, text in self._iter_lines():
            safe = escape(text)
            if kind == "add":
                lines.append(f"[green]+{safe}[/green]")
            elif kind == "del":
                lines.append(f"[red]-{safe}[/red]")
            else:
                lines.append(f"[dim] {safe}[/dim]")
        return "\n".join(lines)
