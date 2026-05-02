"""Project picker -- select working directory before launching engine."""
from __future__ import annotations
import os
import subprocess
import asyncio
from pathlib import Path
from textual.screen import Screen
from textual.widgets import Static, Input, Button, Footer
from textual.containers import Vertical, Horizontal


# Recent projects stored in ~/.cynco/recent_projects.txt
RECENT_FILE = Path.home() / ".cynco" / "recent_projects.txt"


def load_recent_projects() -> list[str]:
    """Load recently used project directories."""
    if RECENT_FILE.exists():
        lines = RECENT_FILE.read_text().strip().split("\n")
        return [p for p in lines if p and Path(p).is_dir()][:10]
    return []


def save_recent_project(path: str) -> None:
    """Add a project to the recent list."""
    RECENT_FILE.parent.mkdir(parents=True, exist_ok=True)
    recent = load_recent_projects()
    # Move to top if already in list
    if path in recent:
        recent.remove(path)
    recent.insert(0, path)
    RECENT_FILE.write_text("\n".join(recent[:10]) + "\n")


class ProjectPicker(Screen):
    """Pick a project directory to work in. Launches engine automatically."""

    DEFAULT_CSS = """
    ProjectPicker {
        align: center middle;
    }

    #picker-container {
        width: 80%;
        max-width: 100;
        height: auto;
        max-height: 80%;
        background: $surface;
        border: heavy $accent;
        padding: 2 3;
    }

    #project-input {
        margin: 1 0;
    }

    #recent-list {
        height: auto;
        max-height: 15;
        margin: 1 0;
    }

    .recent-btn {
        width: 100%;
        margin-bottom: 0;
    }

    #button-row {
        height: 3;
        align: center middle;
        margin-top: 1;
    }
    """

    BINDINGS = [
        ("escape", "quit", "Quit"),
    ]

    def compose(self):
        recent = load_recent_projects()
        with Vertical(id="picker-container"):
            yield Static("[bold]LocalCode[/bold] — Local AI Coding Assistant\n")
            yield Static("Enter a project directory to work in:")
            yield Input(
                placeholder="C:\\Users\\you\\project or /home/you/project",
                value=os.getcwd(),
                id="project-input",
            )

            if recent:
                yield Static("\n[bold]Recent Projects:[/bold]")
                with Vertical(id="recent-list"):
                    for proj in recent:
                        name = os.path.basename(proj)
                        yield Button(
                            f"{name}  [dim]{proj}[/dim]",
                            variant="default",
                            id=f"recent-{hash(proj) % 100000}",
                            classes="recent-btn",
                            name=proj,
                        )

            with Horizontal(id="button-row"):
                yield Button("Launch", variant="primary", id="launch")
                yield Button("Quit", variant="error", id="quit")

        yield Footer()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "quit":
            self.app.exit()
            return

        if event.button.id == "launch":
            input_widget = self.query_one("#project-input", Input)
            path = input_widget.value.strip()
            if path:
                self._launch_project(path)
            return

        # Recent project button
        if event.button.name:
            self._launch_project(event.button.name)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Enter key in input box launches the project."""
        path = event.value.strip()
        if path:
            self._launch_project(path)

    def _launch_project(self, path: str) -> None:
        """Validate path, launch engine, switch to workspace."""
        path = os.path.expanduser(path)
        if not os.path.isdir(path):
            self.notify(f"Directory not found: {path}", severity="error")
            return

        save_recent_project(path)
        self.app.project_dir = path
        self.app.sub_title = f"Project: {os.path.basename(path)}"

        # Launch engine process in background
        self.notify(f"Launching engine in {path}...", severity="information")
        asyncio.ensure_future(self._start_engine_and_connect(path))

    async def _start_engine_and_connect(self, project_dir: str) -> None:
        """Spawn the engine process and connect to it."""
        import sys

        # Kill any existing engine on the port first
        port = getattr(self.app, 'bridge_port', 9160)
        try:
            if sys.platform == "win32":
                result = subprocess.run(
                    ["netstat", "-ano"], capture_output=True, text=True, timeout=5
                )
                for line in result.stdout.split("\n"):
                    if f":{port}" in line and "LISTENING" in line:
                        parts = line.split()
                        pid = parts[-1].strip()
                        if pid.isdigit():
                            subprocess.run(["taskkill", "/PID", pid, "/F"],
                                         capture_output=True, timeout=5)
                            self.notify(f"Killed stale engine (PID {pid})", severity="warning")
            else:
                subprocess.run(["fuser", "-k", f"{port}/tcp"],
                             capture_output=True, timeout=5)
        except Exception:
            pass

        # Also kill any previous engine process we spawned
        if hasattr(self.app, 'engine_process') and self.app.engine_process:
            try:
                self.app.engine_process.kill()
                self.app.engine_process.wait(timeout=3)
            except Exception:
                pass

        # Find bun and engine entry point
        engine_script = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
            "engine", "main.ts",
        )

        if not os.path.exists(engine_script):
            self.notify(f"Engine not found at {engine_script}", severity="error")
            return

        # Get model from config or env
        model = os.environ.get("LOCALCODE_MODEL") or getattr(self.app.config, "model", None) or "gemma4:31b"
        context_length = os.environ.get("LOCALCODE_CONTEXT_LENGTH") or str(getattr(self.app.config, "context_length", 65536))

        env = {**os.environ, "LOCALCODE_MODEL": model, "LOCALCODE_CONTEXT_LENGTH": context_length}

        try:
            # Find bun executable — on Windows needs .cmd extension or full path
            import shutil
            bun_cmd = shutil.which("bun") or "bun"

            # Spawn engine process (shell=True on Windows to resolve .cmd files)
            # stdout/stderr MUST NOT be PIPE — if the pipe buffer fills
            # (4KB on Windows), console.log blocks the Bun event loop,
            # deadlocking all async operations including fetch.
            # Write to a log file instead so we can still debug.
            import tempfile
            log_path = os.path.join(project_dir, '.cynco-engine.log')
            log_file = open(log_path, 'w')
            if sys.platform == "win32":
                # On Windows: shell=True needs a string command, not a list.
                # Quote paths in case they contain spaces.
                cmd = f'"{bun_cmd}" "{engine_script}"'
                self.app.engine_process = subprocess.Popen(
                    cmd,
                    cwd=project_dir,
                    env=env,
                    stdout=log_file,
                    stderr=log_file,
                    shell=True,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                self.app.engine_process = subprocess.Popen(
                    [bun_cmd, engine_script],
                    cwd=project_dir,
                    env=env,
                    stdout=log_file,
                    stderr=log_file,
                )
            self.app._engine_log_file = log_file
            self.notify(f"Engine starting with: {bun_cmd}", severity="information")

            # Give engine time to start — first launch installs LSPs which takes longer
            await asyncio.sleep(3)

            # Connect the bridge
            if self.app.bridge:
                try:
                    await self.app.bridge.disconnect()
                except Exception:
                    pass

            from ..bridge import EngineBridge

            # Try base port and fallbacks (engine tries same ports if base is stuck)
            base_port = self.app.bridge_port
            ports_to_try = [base_port, base_port + 1, base_port + 2]
            connected = False

            retries = 30  # More retries for first-launch or llama-server model load
            for attempt in range(retries):
                for port in ports_to_try:
                    try:
                        self.app.bridge = EngineBridge(port=port, on_event=self.app._on_engine_event)
                        await self.app.bridge.connect()
                        self.app.bridge_port = port
                        self.notify(f"Connected to engine on port {port}!", severity="information")
                        connected = True
                        break
                    except Exception:
                        pass
                if connected:
                    break
                if attempt < retries - 1:
                    await asyncio.sleep(1)

            if not connected:
                self.notify("Failed to connect to engine after 30 retries", severity="error")
                return

            # Switch to workspace
            from .workspace import WorkspaceScreen
            self.app.switch_screen(WorkspaceScreen())

        except FileNotFoundError:
            self.notify("'bun' not found. Is it installed and on PATH?", severity="error")
        except Exception as e:
            self.notify(f"Engine launch failed: {e}", severity="error")
