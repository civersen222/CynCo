"""Confidence meter — shows how well the AI understands the task."""
from textual.widgets import Static


class ConfidenceBar(Static):
    """Displays confidence across 4 dimensions with overall percentage."""

    DEFAULT_CSS = """
    ConfidenceBar {
        height: auto;
        padding: 0 1;
        margin: 0 0 1 0;
    }
    """

    PHASE_LABELS = {
        "idle": ("dim", "Ready"),
        "understand": ("cyan", "Understanding"),
        "build": ("yellow", "Building"),
        "report": ("green", "Complete"),
        "escalation": ("red", "Needs Help"),
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._overall = 0.0
        self._reason = ""
        self._confidence = {}
        self._phase = "idle"

    def set_phase(self, phase: str) -> None:
        self._phase = phase
        self._render_bar()

    def update_confidence(self, confidence: dict, overall: float, reason: str) -> None:
        self._confidence = confidence
        self._overall = overall
        self._reason = reason
        self._render_bar()

    def _render_bar(self) -> None:
        phase_color, phase_label = self.PHASE_LABELS.get(self._phase, ("dim", self._phase))

        if self._phase == "build":
            self.update(f"[bold {phase_color}]\u2699 {phase_label}...[/bold {phase_color}]")
            return

        if self._phase == "report":
            self.update(f"[bold {phase_color}]\u2713 {phase_label}[/bold {phase_color}]")
            return

        if self._phase == "escalation":
            self.update(f"[bold {phase_color}]\u26a0 {phase_label}[/bold {phase_color}]")
            return

        # understand / idle — show confidence bar
        pct = int(self._overall)
        bar_width = 30
        filled = min(int(bar_width * self._overall / 100), bar_width)

        if pct >= 80:
            color = "green"
        elif pct >= 50:
            color = "yellow"
        else:
            color = "red"

        bar_chars = "\u2588" * filled + "\u2591" * (bar_width - filled)
        bar = f"[{color}]{bar_chars}[/{color}]"
        lines = [f"[bold {phase_color}]{phase_label}:[/bold {phase_color}] {bar} {pct}%"]
        if self._reason:
            lines.append(f"[dim]({self._reason})[/dim]")
        self.update("\n".join(lines))
