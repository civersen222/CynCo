"""Error escalation dialog — shows problems in plain language with options."""
from textual.screen import ModalScreen
from textual.widgets import Static, Button
from textual.containers import Vertical, Horizontal


class EscalationDialog(ModalScreen[str]):
    """Modal for when the AI needs user help with a problem."""

    BINDINGS = [
        ("f", "fix", "Go ahead"),
        ("s", "skip", "Skip"),
        ("e", "explain", "Explain more"),
        ("escape", "skip", "Skip"),
    ]

    DEFAULT_CSS = """
    EscalationDialog {
        align: center middle;
    }
    #escalation-container {
        width: 80%;
        max-width: 90;
        height: auto;
        max-height: 80%;
        background: $surface;
        border: heavy $warning;
        padding: 1 2;
    }
    #escalation-buttons {
        height: 3;
        align: center middle;
        margin: 1 0 0 0;
    }
    #escalation-buttons Button {
        margin: 0 1;
    }
    """

    def __init__(self, problem: str, tried: list, proposal: str, request_id: str):
        super().__init__()
        self.problem = problem
        self.tried = tried
        self.proposal = proposal
        self.request_id = request_id

    def compose(self):
        tried_lines = "\n".join(f"  \u2022 {t}" for t in self.tried)
        yield Vertical(
            Static("[bold yellow]\u26a0 I need your help with something[/bold yellow]"),
            Static(f"\n{self.problem}"),
            Static(f"\n[bold]I tried:[/bold]\n{tried_lines}"),
            Static(f"\n{self.proposal}"),
            Static("\n[dim]Press [bold]f[/bold] to fix, [bold]s[/bold] to skip, [bold]e[/bold] for more detail[/dim]"),
            Horizontal(
                Button("Go ahead and fix it", variant="success", id="fix"),
                Button("Skip this for now", variant="warning", id="skip"),
                Button("Let me explain more", variant="default", id="explain"),
                id="escalation-buttons",
            ),
            id="escalation-container",
        )

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id or "skip")

    def action_fix(self) -> None:
        self.dismiss("fix")

    def action_skip(self) -> None:
        self.dismiss("skip")

    def action_explain(self) -> None:
        self.dismiss("explain")
