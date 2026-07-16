"""AskUser dialog -- modal screen showing an engine question with options or free text."""
from textual.screen import ModalScreen
from textual.widgets import Static, Button, Input
from textual.containers import Vertical, Horizontal


class AskDialog(ModalScreen[str]):
    """Modal dialog for engine ask.request questions. Dismisses with the answer string."""

    DEFAULT_CSS = """
    AskDialog {
        align: center middle;
    }
    #ask-container {
        width: 80%;
        max-width: 90;
        height: auto;
        background: $surface;
        border: heavy $accent;
        padding: 1 2;
    }
    #ask-buttons {
        height: auto;
        align: center middle;
    }
    #ask-buttons Button {
        margin: 0 1;
    }
    """

    def __init__(self, question: str, options: list[str] | None = None):
        super().__init__()
        self.question = question
        self.options = options or []

    def compose(self):
        children = [
            Static("[bold]The assistant has a question[/bold]"),
            Static(f"\n{self.question}\n"),
        ]
        if self.options:
            children.append(Horizontal(
                *[Button(opt, id=f"opt-{i}") for i, opt in enumerate(self.options)],
                id="ask-buttons",
            ))
        else:
            children.append(Input(placeholder="Type your answer and press Enter", id="ask-input"))
        yield Vertical(*children, id="ask-container")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        idx = int(event.button.id.split("-", 1)[1])
        self.dismiss(self.options[idx])

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value)
