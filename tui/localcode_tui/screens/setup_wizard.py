"""First-run setup wizard -- system check, model selection, memory setup."""
from textual.screen import Screen
from textual.widgets import Static, Button, Footer
from textual.containers import Vertical, Center

from ..widgets import ProgressList


class SetupWizard(Screen):
    """Three-step setup: system check, model pick, memory config."""

    BINDINGS = [
        ("escape", "app.pop_screen", "Back"),
    ]

    def compose(self):
        yield Center(
            Vertical(
                Static("[bold]LocalCode Setup[/bold]\n\nLet's get you started!", id="title"),
                ProgressList(
                    steps=["Check system requirements", "Choose a model", "Set up memory"],
                    id="steps",
                ),
                Static("", id="status"),
                Button("Start Setup", variant="primary", id="start"),
                Button("Skip (use defaults)", variant="default", id="skip"),
                id="wizard-container",
            ),
        )
        yield Footer()

    async def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "skip":
            self.app.pop_screen()
            return

        if event.button.id == "start":
            progress = self.query_one("#steps", ProgressList)
            status = self.query_one("#status", Static)

            # Step 1: System check
            progress.set_step_status(0, "active")
            status.update("Checking system requirements...")
            # Check Ollama
            import subprocess
            try:
                result = subprocess.run(
                    ["ollama", "list"], capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    progress.set_step_status(0, "done")
                    status.update("[green]Ollama is installed and running.[/green]")
                else:
                    progress.set_step_status(0, "error")
                    status.update("[red]Ollama not found. Install from ollama.com[/red]")
                    return
            except (FileNotFoundError, subprocess.TimeoutExpired):
                progress.set_step_status(0, "error")
                status.update("[red]Ollama not found. Install from ollama.com[/red]")
                return

            # Step 2: Model selection
            progress.set_step_status(1, "active")
            from .model_picker import ModelPicker
            await self.app.push_screen_wait(ModelPicker())
            progress.set_step_status(1, "done")

            # Step 3: Memory setup
            progress.set_step_status(2, "active")
            status.update("Setting up memory system...")
            # Check Docker
            try:
                subprocess.run(["docker", "compose", "version"], capture_output=True, timeout=5)
                progress.set_step_status(2, "done")
                status.update("[green]Setup complete! Starting LocalCode...[/green]")
            except (FileNotFoundError, subprocess.TimeoutExpired):
                progress.set_step_status(2, "done")
                status.update("[yellow]Docker not found. Memory features disabled.[/yellow]")

            # Done -- proceed to guided mode
            self.app.pop_screen()
