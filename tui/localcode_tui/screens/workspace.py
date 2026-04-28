"""Workspace mode -- split view with chat and file preview."""
from __future__ import annotations
from textual.screen import Screen
from textual.containers import Horizontal, Vertical
from textual.widgets import Input, Footer, OptionList, Static
from textual.widgets.option_list import Option
from textual.containers import Container

from ..widgets import ChatPanel, ContextBar, ToolActivity, ContextSidebar, WorkerAnimation
from ..protocol import SlashCommandMsg


# ─── Slash Commands ─────────────────────────────────────────────

SLASH_COMMANDS = [
    ("/help", "Show available commands"),
    ("/model", "Pick a different model"),
    ("/model <name>", "Switch to a specific model"),
    ("/clear", "Clear the chat history"),
    ("/mode", "Switch to guided mode"),
    ("/quit", "Exit LocalCode"),
    ("/tools", "List available tools and approval requirements"),
    ("/approve-all", "Auto-approve all tool calls for this session"),
    ("/context", "Show current context window status"),
    ("/compact", "Compact the conversation context"),
    ("/read", "Read a file (e.g. /read src/foo.ts)"),
    ("/search", "Search the codebase (e.g. /search TODO)"),
    ("/git", "Show git status and recent changes"),
    ("/commit", "Help create a commit with staged changes"),
    ("/diff", "Show git diff of modified files"),
    ("/brainstorm", "Brainstorm ideas (Phase 2)"),
    ("/plan", "Create an implementation plan (Phase 2)"),
    ("/tdd", "Test-driven development workflow (Phase 2)"),
    ("/debug", "Debug workflow (Phase 2)"),
    ("/review", "Code review workflow (Phase 2)"),
    ("/critique", "Critique workflow (Phase 2)"),
    ("/agent", "Launch sub-agent (Phase 2)"),
    ("/copy", "Copy last assistant response to clipboard"),
    ("/settings", "Open settings"),
    ("/cancel", "Cancel the current running workflow"),
    ("/project", "Start guided project building (vibe loop)"),
    ("/analyze", "Rebuild the project code index"),
]

HELP_TEXT = """[bold]Available Commands:[/bold]

[bold cyan]Chat & Navigation[/bold cyan]
  [cyan]/help[/cyan]         Show this help message
  [cyan]/clear[/cyan]        Clear the chat history
  [cyan]/copy[/cyan]         Copy last response to clipboard
  [cyan]/mode[/cyan]         Switch to guided mode
  [cyan]/quit[/cyan]         Exit LocalCode
  [cyan]/settings[/cyan]     Open settings

[bold cyan]Model[/bold cyan]
  [cyan]/model[/cyan]        Pick a different model interactively
  [cyan]/model <name>[/cyan] Switch to a specific model directly

[bold cyan]Tools & Approval[/bold cyan]
  [cyan]/tools[/cyan]        List available tools and approval requirements
  [cyan]/approve-all[/cyan]  Auto-approve all tool calls for this session
  [cyan]/reset[/cyan]        Reset governance after system halt

[bold cyan]Context[/bold cyan]
  [cyan]/context[/cyan]      Show current context window status
  [cyan]/compact[/cyan]      Compact the conversation context

[bold cyan]Code & Git[/bold cyan]
  [cyan]/read <path>[/cyan]  Read a file and show its contents
  [cyan]/search <q>[/cyan]   Search the codebase for a term
  [cyan]/git[/cyan]          Show git status and recent changes
  [cyan]/commit[/cyan]       Help create a commit with staged changes
  [cyan]/diff[/cyan]         Show git diff of all modified files

[bold cyan]Workflows (Phase 2)[/bold cyan]
  [cyan]/brainstorm[/cyan]   Brainstorm ideas
  [cyan]/plan[/cyan]         Create an implementation plan
  [cyan]/tdd[/cyan]          Test-driven development workflow
  [cyan]/debug[/cyan]        Debug workflow
  [cyan]/review[/cyan]       Code review workflow
  [cyan]/critique[/cyan]     Critique workflow
  [cyan]/agent[/cyan]        Launch a sub-agent
  [cyan]/cancel[/cyan]       Cancel the current running workflow

[bold cyan]Guided Project[/bold cyan]
  [cyan]/project[/cyan]      Start guided project building (vibe loop)

[bold cyan]Keyboard Shortcuts[/bold cyan]
  [cyan]Ctrl+Y[/cyan]       Copy last response to clipboard
  [cyan]Ctrl+N[/cyan]       New chat
  [cyan]Ctrl+F[/cyan]       Toggle file tree
  [cyan]Ctrl+M[/cyan]       Pick model
  [cyan]Shift+drag[/cyan]   Select text in terminal (bypasses TUI mouse capture)

[dim]Type anything else to chat with the model.[/dim]"""


def _format_summary_chip(event) -> str:
    """Format the 'requesting summary...' chip displayed in chat when
    the engine injects a summary request after silent tool use."""
    tools = getattr(event, "tools_used", []) or []
    unique = list(dict.fromkeys(tools))  # preserve order, dedupe
    if len(unique) == 0:
        return "[dim italic]requesting summary...[/]"
    if len(unique) == 1:
        return f"[dim italic]requesting summary after {unique[0]} tool...[/]"
    joined = ", ".join(unique)
    return f"[dim italic]requesting summary after {joined} tools...[/]"


# ─── Explain mode helpers ─────────────────────────────────────

TOOL_FALLBACK_EXPLANATIONS = {
    "Read": "Read the contents of {input}",
    "Edit": "Made changes to {input}",
    "Write": "Created or overwrote file {input}",
    "MultiEdit": "Made changes to multiple locations in {input}",
    "Bash": "Ran a command in the terminal",
    "Grep": "Searched file contents for a pattern",
    "Glob": "Searched for files matching a pattern",
}


def _build_explain_prompt(tool_name: str, tool_input: str, result_preview: str) -> str:
    """Build the prompt for the LLM to explain a tool action in plain language."""
    return (
        f"The AI just used the [{tool_name}] tool.\n"
        f"Input: {tool_input[:200]}\n"
        f"Result: {result_preview[:300]}\n\n"
        f"Explain what this did and why in 2-3 sentences, "
        f"as if talking to someone who doesn't write code."
    )


def _scripted_explanation(tool_name: str, tool_input: str) -> str:
    """Fallback explanation when LLM is unavailable."""
    template = TOOL_FALLBACK_EXPLANATIONS.get(tool_name, "Used the {tool_name} tool")
    if "{input}" in template:
        # Extract the most useful part of the input
        short = tool_input[:60].split("\n")[0] if tool_input else "a file"
        return template.format(input=short)
    return template.format(tool_name=tool_name)


class CommandPalette(Container):
    """Dropdown showing matching slash commands."""

    DEFAULT_CSS = """
    CommandPalette {
        dock: bottom;
        height: auto;
        max-height: 10;
        margin-bottom: 3;
        margin-left: 1;
        margin-right: 1;
        background: $surface;
        border: solid $accent;
        padding: 0 1;
        display: none;
    }
    """

    def update_suggestions(self, prefix: str) -> None:
        """Show commands matching the prefix."""
        self.remove_children()
        matches = [
            (cmd, desc) for cmd, desc in SLASH_COMMANDS
            if cmd.startswith(prefix) or prefix == "/"
        ]
        if not matches:
            self.display = False
            return

        lines = []
        for cmd, desc in matches:
            lines.append(f"  [bold cyan]{cmd}[/bold cyan]  [dim]{desc}[/dim]")

        self.mount(Static("\n".join(lines), markup=True))
        self.display = True

    def hide(self) -> None:
        self.display = False


class WorkspaceScreen(Screen):
    """Developer workspace with chat + file preview."""

    CSS_PATH = "../styles/workspace.tcss"

    BINDINGS = [
        ("ctrl+n", "new_chat", "New Chat"),
        ("ctrl+f", "toggle_files", "Files"),
        ("ctrl+m", "pick_model", "Model"),
        ("ctrl+comma", "open_settings", "Settings"),
        ("ctrl+y", "copy_response", "Copy"),
        ("escape", "focus_input", "Focus Input"),
    ]

    def compose(self):
        yield ContextBar(id="context-bar")
        yield Horizontal(
            Vertical(
                ChatPanel(id="chat"),
                WorkerAnimation(id="worker-anim"),
                CommandPalette(id="cmd-palette"),
                Input(placeholder="Ask me anything... (or /help for commands)", id="input"),
                id="left-pane",
            ),
            ContextSidebar(id="sidebar"),
            id="main-split",
        )
        yield ToolActivity(id="tool-activity")
        yield Footer()

    def on_mount(self) -> None:
        """Focus the input when workspace loads."""
        self.query_one("#input", Input).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Show command palette when typing /."""
        palette = self.query_one("#cmd-palette", CommandPalette)
        text = event.value
        if text.startswith("/") and not text.startswith("/ "):
            palette.update_suggestions(text.split()[0] if text.strip() else "/")
        else:
            palette.hide()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle user input — slash commands or chat messages."""
        # Hide palette on submit
        self.query_one("#cmd-palette", CommandPalette).hide()

        text = event.value.strip()
        if not text:
            return
        event.input.value = ""

        # Slash command handling
        if text.startswith("/"):
            self._handle_slash_command(text)
            return

        # Regular message
        chat = self.query_one("#chat", ChatPanel)
        chat.add_user_message(text)
        self.app.send_message(text)
        # Start worker animation
        try:
            worker = self.query_one("#worker-anim", WorkerAnimation)
            worker.start_activity("build")
        except Exception:
            pass

    def _handle_slash_command(self, text: str) -> None:
        """Parse and execute slash commands."""
        parts = text.split(None, 1)
        command = parts[0].lower()
        args = parts[1] if len(parts) > 1 else ""
        chat = self.query_one("#chat", ChatPanel)

        if command == "/help":
            chat.add_system_message(HELP_TEXT)

        elif command == "/model":
            if args:
                chat.add_system_message(f"Switching model to [bold]{args}[/bold]...")
                self.app.switch_model(args)
            else:
                self.action_pick_model()

        elif command == "/clear":
            chat.clear()
            chat.add_system_message("Chat cleared.")

        elif command == "/mode":
            from .guided import GuidedScreen
            self.app.switch_screen(GuidedScreen())

        elif command in ("/quit", "/exit"):
            import asyncio
            asyncio.ensure_future(self.app.action_quit())

        elif command == "/settings":
            self.action_open_settings()

        elif command == "/profile":
            if "new" in args.lower():
                self.action_new_profile()
            else:
                chat.add_system_message("[dim]Usage: /profile new — create a new profile[/dim]")

        elif command == "/copy":
            text = chat.get_last_response()
            if text:
                import subprocess
                import sys
                try:
                    if sys.platform == "win32":
                        cmd_args = ["clip.exe"]
                    elif sys.platform == "darwin":
                        cmd_args = ["pbcopy"]
                    else:
                        cmd_args = ["xclip", "-selection", "clipboard"]
                    proc = subprocess.Popen(
                        cmd_args,
                        stdin=subprocess.PIPE,
                    )
                    proc.communicate(text.encode("utf-8"))
                    chat.add_system_message("[green]\u2713[/green] Last response copied to clipboard.")
                except Exception as e:
                    chat.add_system_message(f"[red]Copy failed: {e}[/red]")
            else:
                chat.add_system_message("[dim]No response to copy.[/dim]")

        elif command == "/project":
            import os
            project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
            has_files = os.path.isdir(project_dir) and any(
                not f.startswith('.') and f not in ('node_modules', '__pycache__', 'venv')
                for f in os.listdir(project_dir)
            )
            if has_files:
                # Existing project → vibe loop with project scan
                from .vibe_loop import VibeLoopScreen
                self.app.switch_screen(VibeLoopScreen())
            else:
                # Empty/new project → ProjectWizard (research → brainstorm → design → plan)
                from .project_wizard import ProjectWizard
                def on_project_dismiss(result) -> None:
                    if result and isinstance(result, list):
                        from .vibe_loop import VibeLoopScreen
                        self.app.switch_screen(VibeLoopScreen(phases=result))
                self.app.push_screen(ProjectWizard(), on_project_dismiss)

        else:
            # Route all other commands to the engine
            from ..protocol import SlashCommandMsg
            cmd = SlashCommandMsg(command=command, args=args)
            self.app.send_command(cmd)

    def action_new_chat(self) -> None:
        chat = self.query_one("#chat", ChatPanel)
        chat.clear()
        chat.add_system_message("New chat started.")

    def action_focus_input(self) -> None:
        self.query_one("#input", Input).focus()

    def action_toggle_files(self) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sidebar.display = not sidebar.display

    def action_pick_model(self) -> None:
        from .model_picker import ModelPicker

        async def on_model_selected(model: str) -> None:
            if model:
                chat = self.query_one("#chat", ChatPanel)
                chat.add_system_message(f"Model switched to [bold]{model}[/bold]")
                self.app.switch_model(model)

        self.app.push_screen(ModelPicker(), on_model_selected)

    def action_copy_response(self) -> None:
        """Copy the last assistant response to clipboard."""
        chat = self.query_one("#chat", ChatPanel)
        text = chat.get_last_response()
        if text:
            import subprocess
            import sys
            try:
                if sys.platform == "win32":
                    cmd_args = ["clip.exe"]
                elif sys.platform == "darwin":
                    cmd_args = ["pbcopy"]
                else:
                    cmd_args = ["xclip", "-selection", "clipboard"]
                proc = subprocess.Popen(cmd_args, stdin=subprocess.PIPE)
                proc.communicate(text.encode("utf-8"))
                chat.add_system_message("[green]\u2713[/green] Copied to clipboard.")
            except Exception as e:
                chat.add_system_message(f"[red]Copy failed: {e}[/red]")
        else:
            chat.add_system_message("[dim]No response to copy.[/dim]")

    def action_open_settings(self) -> None:
        """Open the settings modal."""
        from .settings import SettingsScreen
        config_values = {}
        try:
            app_config = self.app.config
            config_values = {
                "model": app_config.model,
                "temperature": app_config.temperature,
                "max_output_tokens": app_config.max_output_tokens,
                "timeout": getattr(app_config, "timeout", 300000),
                "base_url": app_config.base_url,
                "context_length": app_config.context_length,
                "theme": app_config.ui.theme,
                "default_mode": app_config.ui.default_mode,
                "show_token_count": app_config.ui.show_token_count,
                "show_context_bar": app_config.ui.show_context_bar,
                "warning_threshold": app_config.context_management.warning_threshold,
                "hard_limit": app_config.context_management.hard_limit,
                "tier": "auto",
            }
        except Exception:
            pass
        self.app.push_screen(SettingsScreen(initial_config=config_values))

    def action_new_profile(self) -> None:
        """Open the profile creation wizard."""
        from .profile_wizard import ProfileWizard

        def on_wizard_dismiss(result) -> None:
            if result:
                chat = self.query_one("#chat", ChatPanel)
                chat.add_system_message(f"[green]\u2713[/green] Profile '{result}' created! Activate it in Settings > Profiles.")

        self.app.push_screen(ProfileWizard(), on_wizard_dismiss)

    async def handle_approval_request(self, event) -> None:
        """Handle tool approval request from engine."""
        from ..widgets.approval import ApprovalDialog

        dialog = ApprovalDialog(
            tool_name=event.tool_name,
            description=event.description,
            risk=event.risk,
        )

        async def on_result(approved: bool) -> None:
            from ..protocol import ApprovalResponseCommand
            cmd = ApprovalResponseCommand(
                request_id=event.request_id,
                approved=approved,
            )
            self.app.send_command(cmd)

        self.app.push_screen(dialog, on_result)

    def handle_tool_start(self, event) -> None:
        chat = self.query_one("#chat", ChatPanel)
        chat.add_system_message(f"[dim]\u25b6 Running tool: [bold]{event.tool_name}[/bold][/dim]")
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sidebar.log_tool(event.tool_name, status="running")

    def handle_tool_complete(self, event) -> None:
        chat = self.query_one("#chat", ChatPanel)
        status = "[red]\u2717[/red]" if event.is_error else "[green]\u2713[/green]"
        result_preview = str(event.result)[:200] if event.result else ""
        chat.add_system_message(f"[dim]{status} Tool complete: {result_preview}[/dim]")

        sidebar = self.query_one("#sidebar", ContextSidebar)
        tool_status = "error" if event.is_error else "ok"
        sidebar.log_tool(event.tool_name, status=tool_status, preview=result_preview[:80])

        # If it was a Read tool, show file in sidebar preview and track it
        if event.tool_name == "Read" and not event.is_error and event.result:
            result_str = str(event.result)
            sidebar.add_file(result_str.split("\n")[0].strip() if result_str else "file")
            sidebar.show_preview("File", result_str[:2000])
        # Track files from Glob/Grep results
        elif event.tool_name in ("Glob", "Grep") and not event.is_error and event.result:
            result_str = str(event.result)
            for line in result_str.split("\n")[:10]:
                path = line.strip()
                if path:
                    sidebar.add_file(path, tool=event.tool_name)

        # Explain mode: request plain-language explanation for non-advanced users
        expertise = getattr(self, "_expertise", "advanced")
        if expertise in ("beginner", "intermediate") and not event.is_error:
            self._request_tool_explanation(event, expertise)

    def _request_tool_explanation(self, event, expertise: str) -> None:
        """Send a wizard.query to explain what a tool just did."""
        import json
        import uuid
        tool_name = getattr(event, "tool_name", "?")
        tool_input = str(getattr(event, "input", "") or "")[:200] if hasattr(event, "input") else ""
        result_preview = str(getattr(event, "result", "") or "")[:300]

        req_id = f"explain-{uuid.uuid4().hex[:8]}"
        if not hasattr(self, "_explain_pending"):
            self._explain_pending = {}
        self._explain_pending[req_id] = {
            "tool_name": tool_name,
            "tool_input": tool_input,
            "expertise": expertise,
        }

        try:
            self.app.send_raw_command(json.dumps({
                "type": "wizard.query",
                "requestId": req_id,
                "systemPrompt": "You are explaining code changes to someone who doesn't write code. Be friendly and clear. 2-3 sentences max.",
                "prompt": _build_explain_prompt(tool_name, tool_input, result_preview),
            }))
        except Exception:
            # LLM unavailable — use scripted fallback
            chat = self.query_one("#chat", ChatPanel)
            fallback = _scripted_explanation(tool_name, tool_input)
            chat.add_system_message(f"[dim]  \u2139 {fallback}[/dim]")

    def handle_wizard_response(self, event) -> None:
        """Handle wizard.response — used by explain mode."""
        req_id = getattr(event, "request_id", "")
        text = getattr(event, "text", "")
        error = getattr(event, "error", None)

        pending = getattr(self, "_explain_pending", {})
        if req_id not in pending:
            return  # Not an explain-mode response

        info = pending.pop(req_id)
        chat = self.query_one("#chat", ChatPanel)

        if error or not text.strip():
            # LLM failed — use scripted fallback
            fallback = _scripted_explanation(info["tool_name"], info["tool_input"])
            chat.add_system_message(f"[dim]  \u2139 {fallback}[/dim]")
        elif info["expertise"] == "beginner":
            # Always visible for beginners
            chat.add_system_message(f"[dim]  \u2139 {text.strip()}[/dim]")
        else:
            # Collapsible for intermediate (show as dimmer hint)
            chat.add_system_message(f"[dim italic]  [? What happened?] {text.strip()}[/dim italic]")

    def handle_governance_status(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sidebar.set_governance(
            health=event.health,
            s3s4=event.s3s4_balance,
            success_rate=event.tool_success_rate,
            stuck=event.stuck_turns,
            suggestion=event.suggestion,
        )

        # Passive guardian warnings for intermediate users
        expertise = getattr(self, "_expertise", "advanced")
        if expertise == "intermediate":
            chat = self.query_one("#chat", ChatPanel)
            if event.stuck_turns >= 3:
                chat.add_system_message(
                    "[dim yellow]Note: the AI has been stuck for "
                    f"{event.stuck_turns} turns. It might need a different approach.[/dim yellow]"
                )
            if event.tool_success_rate < 0.5 and event.tool_success_rate > 0:
                chat.add_system_message(
                    "[dim yellow]Note: several tool calls have failed. "
                    "The AI may be struggling with this task.[/dim yellow]"
                )

    def handle_summary_injected(self, event) -> None:
        try:
            from ..widgets.chat_panel import ChatPanel
            chat = self.query_one("#chat", ChatPanel)
            chat.add_system_message(_format_summary_chip(event))
        except Exception:
            pass

    def handle_memory_recalled(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sc = getattr(event, "session_context", None)
        if sc and isinstance(sc, dict):
            sidebar.set_prior_session(
                goal=sc.get("prior_goal", ""),
                status=sc.get("prior_status", ""),
                date_relative=sc.get("prior_date", ""),
                open_threads=sc.get("open_threads", []),
            )
        memories = getattr(event, "memories", [])
        if memories:
            sidebar.set_recalled_memories(memories)

    def handle_memory_written(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sidebar.log_memory_write(
            kind=getattr(event, "kind", "handoff"),
            summary=getattr(event, "summary", ""),
        )

    def handle_workflow_status(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        if event.active:
            sidebar.set_workflow(event.display_name, event.phase)
            # Build todo items from workflow phase progression
            phase = getattr(event, "phase", None)
            if phase:
                if not hasattr(self, "_workflow_phases_seen"):
                    self._workflow_phases_seen = []
                if phase not in self._workflow_phases_seen:
                    self._workflow_phases_seen.append(phase)
                todos = []
                for p in self._workflow_phases_seen:
                    status = "completed" if p != phase else "in_progress"
                    todos.append({"content": p, "status": status})
                sidebar.set_todos(todos)
        else:
            sidebar.set_workflow(None, None)
            if hasattr(self, "_workflow_phases_seen"):
                # Mark all as completed when workflow finishes
                todos = [{"content": p, "status": "completed"} for p in self._workflow_phases_seen]
                sidebar.set_todos(todos)
                self._workflow_phases_seen = []

    # ─── Guided Project ────────────────────────────────────────────

    def action_start_project(self) -> None:
        # Check for saved project state first
        if self._load_project_state():
            chat = self.query_one("#chat", ChatPanel)
            idx = self._project_phase_idx
            total = len(self._project_phases)
            if idx < total:
                chat.add_system_message(
                    f"[bold cyan]Resuming project — Phase {idx + 1}/{total}: "
                    f"{self._project_phases[idx]['name']}[/bold cyan]\n"
                    f"[dim]Type /next to continue, /project new to start fresh.[/dim]"
                )
                # Update sidebar todos
                sidebar = self.query_one("#sidebar", ContextSidebar)
                todos = []
                for i, p in enumerate(self._project_phases):
                    status = "completed" if i < idx else ("in_progress" if i == idx else "pending")
                    todos.append({"content": p["name"], "status": status})
                sidebar.set_todos(todos)
                return
            else:
                chat.add_system_message("[bold green]Previous project is complete.[/bold green] Starting new project.")

        from .project_wizard import ProjectWizard
        def on_project_dismiss(result) -> None:
            if result and isinstance(result, list):
                self._execute_project_phases(result)
        self.app.push_screen(ProjectWizard(), on_project_dismiss)

    def _execute_project_phases(self, phases: list[dict]) -> None:
        chat = self.query_one("#chat", ChatPanel)
        sidebar = self.query_one("#sidebar", ContextSidebar)
        todos = [{"content": p["name"], "status": "pending"} for p in phases]
        sidebar.set_todos(todos)
        self._project_phases = phases
        self._project_phase_idx = 0
        self._save_project_state()
        self._execute_next_project_phase()

    def _save_project_state(self) -> None:
        """Persist project state to disk so it survives restarts."""
        import json
        import os
        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        state_path = os.path.join(project_dir, '.cynco-project.json')
        try:
            state = {
                "phases": getattr(self, "_project_phases", []),
                "phase_idx": getattr(self, "_project_phase_idx", 0),
            }
            with open(state_path, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception:
            pass

    def _load_project_state(self) -> bool:
        """Load saved project state from disk. Returns True if found."""
        import json
        import os
        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        state_path = os.path.join(project_dir, '.cynco-project.json')
        try:
            if os.path.exists(state_path):
                with open(state_path) as f:
                    state = json.load(f)
                self._project_phases = state.get("phases", [])
                self._project_phase_idx = state.get("phase_idx", 0)
                return len(self._project_phases) > 0
        except Exception:
            pass
        return False

    def _execute_next_project_phase(self) -> None:
        if not hasattr(self, "_project_phases") or not self._project_phases:
            return
        idx = self._project_phase_idx
        if idx >= len(self._project_phases):
            chat = self.query_one("#chat", ChatPanel)
            chat.add_system_message(
                "[bold green]Project complete![/bold green] All phases finished.\n\n"
                "[bold cyan]Running wire check...[/bold cyan]\n"
                "[dim]Verifying all code is connected and nothing is dead.[/dim]"
            )
            sidebar = self.query_one("#sidebar", ContextSidebar)
            todos = [{"content": p["name"], "status": "completed"} for p in self._project_phases]
            sidebar.set_todos(todos)
            # Auto wire-check: ask the model to verify everything is connected
            self.app.send_message(
                "IMPORTANT: The project is complete. Before we finish, do a wire check. "
                "Read each file created in this project. For every exported function, class, "
                "or component, verify it is imported and used by at least one other file. "
                "For every event listener or handler, verify it has a corresponding emitter. "
                "Report any dead code (defined but never called) and fix it. "
                "This is a blocking requirement — nothing ships with dead code."
            )
            return
        phase = self._project_phases[idx]
        chat = self.query_one("#chat", ChatPanel)
        chat.add_system_message(
            f"\n[bold cyan]Phase {idx + 1}/{len(self._project_phases)}: {phase['name']}[/bold cyan]\n"
            f"[dim]{phase['description']}[/dim]\n"
        )
        sidebar = self.query_one("#sidebar", ContextSidebar)
        todos = []
        for i, p in enumerate(self._project_phases):
            if i < idx:
                todos.append({"content": p["name"], "status": "completed"})
            elif i == idx:
                todos.append({"content": p["name"], "status": "in_progress"})
            else:
                todos.append({"content": p["name"], "status": "pending"})
        sidebar.set_todos(todos)
        self.app.send_message(phase["prompt"])

    def handle_project_checkpoint(self) -> None:
        if not hasattr(self, "_project_phases") or not self._project_phases:
            return
        idx = self._project_phase_idx
        if idx >= len(self._project_phases):
            return
        phase = self._project_phases[idx]
        chat = self.query_one("#chat", ChatPanel)
        chat.add_system_message(
            f"\n[bold]Phase {idx + 1} complete: {phase['name']}[/bold]\n"
            f"[dim]Type [bold]/next[/bold] to continue to the next phase, "
            f"or [bold]/redo[/bold] to retry this phase.[/dim]"
        )
        self._project_phase_idx += 1
        self._save_project_state()

    def handle_session_ready(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        self._expertise = getattr(event, "expertise", "advanced")
        sidebar.set_session_info(
            model=getattr(event, "model", ""),
            context_length=getattr(event, "context_length", 0),
            session_start=getattr(event, "session_start_time", ""),
            expertise=getattr(event, "expertise", "advanced"),
        )
        sidebar.set_lsp_servers(getattr(event, "lsp_servers", []))
        sidebar.set_mcp_servers(getattr(event, "mcp_servers", []))
        sidebar.set_project_info(
            path=getattr(event, "project_path", ""),
            version=getattr(event, "version", ""),
        )

    def handle_context_status(self, event) -> None:
        sidebar = self.query_one("#sidebar", ContextSidebar)
        sidebar.set_context_stats(
            tokens=getattr(event, "estimated_tokens", 0),
            utilization=getattr(event, "utilization", 0.0),
            context_length=getattr(event, "context_length", 0),
        )
