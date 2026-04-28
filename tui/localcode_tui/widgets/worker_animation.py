"""Animated ASCII worker — shows activity during LLM calls.

A simple animated character cycling through tool poses to signal
the model is working. No building — just a guy with tools.
"""
from textual.widgets import Static
from textual.timer import Timer


# Animated frames — guy holding different tools
FRAMES = {
    "search": [
        [" 🔍      ", " \\○╱     ", "  │      ", " ╱ \\     "],
        [" 🔍      ", "  ○╱     ", " ╱│      ", " ╱ \\     "],
        ["    🔍   ", " \\○      ", "  │\\     ", " ╱ \\     "],
        [" 🔍      ", "  ○╱     ", " ╱│      ", " ╱ \\     "],
    ],
    "think": [
        ["  💭     ", " \\○╱     ", "  │      ", " ╱ \\     "],
        [" 💭      ", "  ○      ", " ╱│\\     ", " ╱ \\     "],
        ["   💭    ", " \\○╱     ", "  │      ", " ╱ \\     "],
        ["  💭     ", "  ○      ", " ╱│\\     ", " ╱ \\     "],
    ],
    "build": [
        ["  🔨     ", " \\○╱     ", "  │      ", " ╱ \\     "],
        ["     🔧  ", "  ╲○     ", "   │\\    ", "  ╱ \\    "],
        ["  ⚒      ", " \\○╱     ", "  │      ", " ╱ \\     "],
        ["  📝     ", "  ○╱     ", " ╱│      ", " ╱ \\     "],
        [" ⚡      ", " \\○╱     ", "  │      ", " ╱ \\     "],
        ["     🔧  ", "  ╲○     ", "   │\\    ", "  ╱ \\    "],
    ],
    "idle": [
        ["         ", "  ○      ", " ╱│\\     ", " ╱ \\     "],
    ],
}

# Status messages
STATUS_MESSAGES = {
    "search": [
        "Scouring the web...",
        "Finding references...",
        "Reading articles...",
        "Gathering intel...",
    ],
    "think": [
        "Pondering deeply...",
        "Connecting the dots...",
        "Having a eureka moment...",
        "Consulting the oracle...",
        "Brewing ideas...",
    ],
    "build": [
        "Writing code...",
        "Wiring things up...",
        "Hammering away...",
        "Measuring twice...",
        "Reading files...",
        "Making edits...",
        "Almost there...",
    ],
    "idle": [
        "Ready!",
    ],
}


class WorkerAnimation(Static):
    """Animated ASCII worker shown during LLM activity."""

    DEFAULT_CSS = """
    WorkerAnimation {
        height: 5;
        padding: 0;
        display: none;
        background: $surface;
        content-align: center middle;
        text-align: center;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._activity: str = "idle"
        self._frame: int = 0
        self._timer: Timer | None = None
        self._message_idx: int = 0

    def on_mount(self) -> None:
        self._timer = self.set_interval(0.4, self._tick)

    def start_activity(self, activity: str = "build") -> None:
        self._activity = activity
        self._frame = 0
        self._message_idx = 0
        self.display = True
        self._update_display()

    def advance_progress(self) -> None:
        pass  # No building to advance — kept for API compat

    def stop_activity(self) -> None:
        self._activity = "idle"
        self.display = False

    def _tick(self) -> None:
        if self._activity == "idle":
            return
        self._frame += 1
        if self._frame % 5 == 0:
            msgs = STATUS_MESSAGES.get(self._activity, STATUS_MESSAGES["build"])
            self._message_idx = (self._message_idx + 1) % len(msgs)
        self._update_display()

    def _update_display(self) -> None:
        frames = FRAMES.get(self._activity, FRAMES["idle"])
        frame = frames[self._frame % len(frames)]

        msgs = STATUS_MESSAGES.get(self._activity, STATUS_MESSAGES["idle"])
        msg = msgs[self._message_idx % len(msgs)]

        lines = [f"[dim]{line}[/dim]" for line in frame]
        lines.append(f"[bold cyan]{msg}[/bold cyan]")
        self.update("\n".join(lines))
