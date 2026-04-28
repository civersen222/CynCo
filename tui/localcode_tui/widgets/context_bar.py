"""Context usage bar -- reactive gauge with color states."""
from textual.widgets import Static
from textual.reactive import reactive


class ContextBar(Static):
    """Shows context window utilization with color-coded thresholds."""

    utilization = reactive(0.0)
    warning_threshold = reactive(0.4)
    hard_limit = reactive(0.8)

    DEFAULT_CSS = """
    ContextBar {
        height: 1;
        width: 100%;
        background: $surface;
        content-align: center middle;
    }
    """

    def watch_utilization(self, value: float) -> None:
        self.update(self._render_bar(value))

    def _render_bar(self, util: float) -> str:
        pct = min(int(util * 100), 100)
        bar_width = 40
        filled = int(bar_width * util)
        filled = min(filled, bar_width)

        if util >= self.hard_limit:
            color = "red"
            label = "CRITICAL"
        elif util >= self.warning_threshold:
            color = "yellow"
            label = "WARNING"
        else:
            color = "green"
            label = "OK"

        bar = f"[{color}]{'\u2588' * filled}{'\u2591' * (bar_width - filled)}[/{color}]"
        return f" Context: {bar} {pct}% [{color}]{label}[/{color}]"
