"""Project picker -- select working directory before launching engine."""
from __future__ import annotations
import os
import subprocess
import asyncio
from pathlib import Path
from textual.screen import Screen
from ..job_object import (
    CREATE_SUSPENDED,
    assign_process_to_job,
    close_job,
    create_kill_on_close_job,
    resume_process,
)
from textual.widgets import Static, Input, Button, Footer
from textual.containers import Vertical, Horizontal


# Recent projects stored in ~/.cynco/recent_projects.txt
RECENT_FILE = Path.home() / ".cynco" / "recent_projects.txt"


def build_engine_env(base_env: dict, app_config=None) -> dict:
    """Environment for the spawned engine process.

    The engine's profile (default.yaml when LOCALCODE_PROFILE is unset) is the
    source of truth for model/context. Explicit LOCALCODE_* env vars set by the
    user pass through untouched via base_env.

    ``app_config`` (the TUI's ~/.cynco/config.yml) is deliberately IGNORED:
    forwarding its model as LOCALCODE_MODEL let a stale TUI config silently
    override the engine profile — llama-cpp setup failed on the unknown name
    and every session broke with opaque timeouts (2026-07-02). Model switches
    made in the TUI reach the running engine via the /model command instead.
    """
    return {**base_env}


def read_engine_log_tail(log_path: str, max_lines: int = 8) -> str:
    """Last few lines of the engine log, for surfacing startup failures."""
    try:
        with open(log_path, encoding="utf-8", errors="replace") as f:
            lines = f.read().strip().splitlines()
        return "\n".join(lines[-max_lines:]) if lines else "(engine log is empty)"
    except OSError:
        return "(no engine log found)"


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
        # P1.9: closing the previous job handle reaps the previous TREE —
        # the single-PID kill above only reaches the shell; llama-server is
        # a grandchild and used to survive respawns.
        close_job(getattr(self.app, '_engine_job', None))
        self.app._engine_job = None

        # Find bun and engine entry point
        engine_script = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
            "engine", "main.ts",
        )

        if not os.path.exists(engine_script):
            self.notify(f"Engine not found at {engine_script}", severity="error")
            return

        # Source of truth is the engine's profile; see build_engine_env.
        env = build_engine_env(os.environ, getattr(self.app, "config", None))

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
                # P1.9: spawn SUSPENDED inside a KILL_ON_JOB_CLOSE Job Object
                # so TUI death (even a crash) kills cmd.exe -> bun ->
                # llama-server. Assign must happen before the process runs:
                # descendants inherit job membership only if the parent is
                # already in the job when it spawns them. If job creation
                # fails we degrade to the old plain spawn (flags unchanged).
                job = create_kill_on_close_job()
                flags = subprocess.CREATE_NO_WINDOW | (CREATE_SUSPENDED if job else 0)
                self.app.engine_process = subprocess.Popen(
                    cmd,
                    cwd=project_dir,
                    env=env,
                    stdout=log_file,
                    stderr=log_file,
                    shell=True,
                    creationflags=flags,
                )
                if job:
                    ok = assign_process_to_job(job, self.app.engine_process._handle)
                    if resume_process(self.app.engine_process.pid) == 0:  # ALWAYS resume
                        # Suspended-forever engine would just fail to connect
                        # with no clue — surface the real cause.
                        self.notify(
                            "Engine resume reported 0 threads — engine may be stuck suspended",
                            severity="warning",
                        )
                    if not ok:
                        close_job(job)  # process not in job; close is inert
                        job = None
                self.app._engine_job = job
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
                # If the engine already died (e.g. fatal provider setup error),
                # surface the real cause from its log instead of retrying into
                # a generic connection failure.
                proc = self.app.engine_process
                if proc is not None and proc.poll() is not None:
                    try:
                        log_file.flush()
                    except Exception:
                        pass
                    tail = read_engine_log_tail(log_path)
                    self.notify(
                        f"Engine exited (code {proc.returncode}):\n{tail}",
                        severity="error",
                        timeout=30,
                    )
                    return
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
