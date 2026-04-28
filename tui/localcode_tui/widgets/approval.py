"""Tool approval dialog -- modal screen with Allow/Deny."""
from textual.screen import ModalScreen
from textual.widgets import Static, Button
from textual.containers import Vertical, Horizontal


class ApprovalDialog(ModalScreen[bool]):
    """Modal dialog for tool approval requests."""

    DEFAULT_CSS = """
    ApprovalDialog {
        align: center middle;
    }

    #approval-container {
        width: 80%;
        max-width: 90;
        height: auto;
        max-height: 80%;
        background: $surface;
        border: heavy $accent;
        padding: 1 2;
    }

    #approval-description {
        height: auto;
        max-height: 20;
        overflow-y: auto;
        margin: 1 0;
    }

    #approval-buttons {
        height: 3;
        align: center middle;
    }

    #approval-buttons Button {
        margin: 0 1;
    }
    """

    def __init__(self, tool_name: str, description: str, risk: str = "low"):
        super().__init__()
        self.tool_name = tool_name
        self.description = description
        self.risk = risk

    BINDINGS = [
        ("a", "allow", "Allow"),
        ("d", "deny", "Deny"),
        ("enter", "allow", "Allow"),
        ("escape", "deny", "Deny"),
    ]

    def compose(self):
        risk_color = {"low": "green", "medium": "yellow", "high": "red"}.get(self.risk, "white")
        yield Vertical(
            Static("[bold]Tool Approval Required[/bold]"),
            Static(f"Tool: [bold]{self.tool_name}[/bold]"),
            Static(f"Risk: [{risk_color}]{self.risk}[/{risk_color}]"),
            Static(f"\n{self.description}", id="approval-description"),
            Static("[dim]Press [bold]a[/bold]/Enter to Allow, [bold]d[/bold]/Escape to Deny[/dim]"),
            Horizontal(
                Button("Allow", variant="success", id="allow"),
                Button("Deny", variant="error", id="deny"),
                id="approval-buttons",
            ),
            id="approval-container",
        )

    def action_allow(self) -> None:
        self.dismiss(True)

    def action_deny(self) -> None:
        self.dismiss(False)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "allow")
