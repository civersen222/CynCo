"""Model picker -- queries Ollama for locally installed models."""
import httpx
from textual.screen import ModalScreen
from textual.widgets import Static, Button, OptionList
from textual.widgets.option_list import Option
from textual.containers import Vertical


def _format_size(size_bytes: int) -> str:
    """Format byte count to human-readable string."""
    if size_bytes >= 1_000_000_000:
        return f"{size_bytes / 1_000_000_000:.1f}GB"
    if size_bytes >= 1_000_000:
        return f"{size_bytes / 1_000_000:.0f}MB"
    return f"{size_bytes / 1_000:.0f}KB"


def fetch_local_models(base_url: str = "http://localhost:11434") -> list[tuple[str, str]]:
    """Query Ollama /api/tags for installed models. Returns [(name, size_str), ...]."""
    try:
        resp = httpx.get(f"{base_url}/api/tags", timeout=5.0)
        resp.raise_for_status()
        data = resp.json()
        models = []
        for m in data.get("models", []):
            name = m.get("name", "unknown")
            size = _format_size(m.get("size", 0))
            models.append((name, size))
        models.sort(key=lambda x: x[0])
        return models
    except Exception:
        return []


class ModelPicker(ModalScreen[str]):
    """Pick from locally installed Ollama models."""

    DEFAULT_CSS = """
    ModelPicker {
        align: center middle;
    }

    #picker-container {
        width: 65;
        height: auto;
        max-height: 30;
        background: $surface;
        border: heavy $accent;
        padding: 1 2;
    }
    """

    def __init__(self, base_url: str = "http://localhost:11434", **kwargs):
        super().__init__(**kwargs)
        self.base_url = base_url
        self._models: list[tuple[str, str]] = []

    def compose(self):
        yield Vertical(
            Static("[bold]Choose a Model[/bold]\n", id="picker-title"),
            Static("[dim]Loading models from Ollama...[/dim]", id="picker-loading"),
            id="picker-container",
        )

    def on_mount(self) -> None:
        """Fetch models async to avoid blocking the TUI."""
        self.run_worker(self._load_models, exclusive=True)

    async def _load_models(self) -> None:
        import asyncio
        # Run blocking fetch in thread to avoid freezing TUI
        self._models = await asyncio.to_thread(fetch_local_models, self.base_url)
        container = self.query_one("#picker-container", Vertical)
        loading = self.query_one("#picker-loading", Static)
        loading.remove()
        if self._models:
            options = [
                Option(f"{name}  [dim]({size})[/dim]", id=name)
                for name, size in self._models
            ]
            container.mount(OptionList(*options, id="model-list"))
            container.mount(Button("Select", variant="primary", id="select"))
        else:
            container.mount(Static(
                "[bold red]No models found[/bold red]\n\n"
                f"Could not reach Ollama at {self.base_url}\n"
                "Make sure Ollama is running: [bold]ollama serve[/bold]\n\n"
                "Then pull a model: [bold]ollama pull qwen3:8b[/bold]"
            ))
            container.mount(Button("Close", variant="error", id="close"))

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "close":
            self.dismiss("")
            return
        try:
            option_list = self.query_one("#model-list", OptionList)
            if option_list.highlighted is not None:
                idx = option_list.highlighted
                model_id = self._models[idx][0]
                self.dismiss(model_id)
            elif self._models:
                self.dismiss(self._models[0][0])
        except Exception:
            self.dismiss("")
