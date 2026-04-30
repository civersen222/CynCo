"""Vibe loop screen — persistent Q&A workflow for non-engineers.

Manages the UNDERSTAND -> BUILD -> REPORT -> NEXT cycle.
Accepts optional `phases` from ProjectWizard for phase-by-phase execution.
"""
import json
import os
from textual.screen import Screen
from textual.widgets import Static, Input, Button
from textual.containers import Vertical, Horizontal
from ..widgets.chat_panel import ChatPanel
from ..widgets.confidence_bar import ConfidenceBar
from ..widgets.completion_screen import CompletionCard
from ..widgets.worker_animation import WorkerAnimation
from ..widgets.context_sidebar import ContextSidebar


class VibeLoopScreen(Screen):
    """Main vibe loop screen — the user never leaves this."""

    DEFAULT_CSS = """
    VibeLoopScreen {
        layout: vertical;
    }

    #vibe-split {
        height: 1fr;
    }

    #vibe-main {
        width: 2fr;
    }

    #vibe-sidebar {
        width: 1fr;
    }

    #vibe-confidence {
        height: auto;
        dock: top;
    }

    #vibe-completion {
        height: auto;
        display: none;
    }

    #vibe-completion.visible {
        display: block;
    }

    #vibe-just-build {
        dock: bottom;
        height: 3;
        margin: 0 1;
        display: none;
    }

    #vibe-just-build.visible {
        display: block;
    }

    #vibe-phase-bar {
        height: auto;
        dock: top;
        display: none;
    }

    #vibe-phase-bar.visible {
        display: block;
        background: $accent-darken-2;
        padding: 0 1;
    }
    """

    BINDINGS = [
        ("escape", "focus_input", "Focus Input"),
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+j", "just_build", "Just Build It"),
        ("ctrl+x", "stop_model", "Stop"),
    ]

    def __init__(self, phases: list | None = None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._state = "idle"
        self._current_question_id = ""
        self._phases = phases or []
        self._phase_idx = 0

    def compose(self):
        yield Static("", id="vibe-phase-bar")
        yield ConfidenceBar(id="vibe-confidence")
        yield Horizontal(
            Vertical(
                ChatPanel(id="vibe-chat"),
                CompletionCard(id="vibe-completion"),
                WorkerAnimation(id="vibe-worker"),
                Button("Just build it — I trust you", variant="warning", id="vibe-just-build"),
                Input(placeholder="Describe what you want to build...", id="vibe-input"),
                id="vibe-main",
            ),
            ContextSidebar(id="vibe-sidebar"),
            id="vibe-split",
        )

    def on_mount(self) -> None:
        """If phases were provided by ProjectWizard, start executing them."""
        if self._phases:
            self._show_phase_bar()
            self._execute_current_phase()
        else:
            # Check for saved project state — show but don't auto-execute
            self._load_project_state()
            if self._phases and self._phase_idx < len(self._phases):
                self._show_phase_bar()
                try:
                    chat = self.query_one("#vibe-chat", ChatPanel)
                    idx = self._phase_idx
                    total = len(self._phases)
                    name = self._phases[idx].get('name', 'Unknown')
                    chat.add_system_message(
                        f"[bold cyan]Found saved project — Phase {idx + 1}/{total}: {name}[/bold cyan]\n"
                        f"[dim]Type 'resume' to continue this phase, or describe what you want to do instead.[/dim]"
                    )
                except Exception:
                    pass

    def _show_phase_bar(self) -> None:
        """Show the phase progress bar at the top."""
        try:
            bar = self.query_one("#vibe-phase-bar", Static)
            bar.add_class("visible")
            self._update_phase_bar()
        except Exception:
            pass

    def _update_phase_bar(self) -> None:
        """Update the phase progress display."""
        if not self._phases:
            return
        try:
            bar = self.query_one("#vibe-phase-bar", Static)
            total = len(self._phases)
            idx = self._phase_idx
            parts = []
            for i, p in enumerate(self._phases):
                if i < idx:
                    parts.append(f"[green]✓ {p['name']}[/green]")
                elif i == idx:
                    parts.append(f"[bold cyan]▸ {p['name']}[/bold cyan]")
                else:
                    parts.append(f"[dim]○ {p['name']}[/dim]")
            bar.update(f"[bold]Phase {min(idx + 1, total)}/{total}[/bold]  " + "  ".join(parts))
        except Exception:
            pass

    def _execute_current_phase(self) -> None:
        """Execute the current phase via the vibe controller."""
        if self._phase_idx >= len(self._phases):
            # All phases done — run wire check
            chat = self.query_one("#vibe-chat", ChatPanel)
            chat.add_system_message(
                "[bold green]All phases complete![/bold green]\n\n"
                "[bold cyan]Running wire check...[/bold cyan]\n"
                "[dim]Verifying all code is connected and nothing is dead.[/dim]"
            )
            self._save_project_state()
            self.app.send_message(
                "IMPORTANT: The project is complete. Before we finish, do a wire check. "
                "Read each file created in this project. For every exported function, class, "
                "or component, verify it is imported and used by at least one other file. "
                "For every event listener or handler, verify it has a corresponding emitter. "
                "Report any dead code (defined but never called) and fix it. "
                "This is a blocking requirement — nothing ships with dead code."
            )
            return

        phase = self._phases[self._phase_idx]
        chat = self.query_one("#vibe-chat", ChatPanel)
        chat.add_system_message(
            f"\n[bold cyan]Phase {self._phase_idx + 1}/{len(self._phases)}: {phase['name']}[/bold cyan]\n"
            f"[dim]{phase.get('description', '')}[/dim]\n"
        )
        self._update_phase_bar()
        self._save_project_state()

        # Start building this phase — send the phase prompt via vibe.action
        try:
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            worker.start_activity("build")
        except Exception:
            pass

        # Send the phase prompt as a build command
        from ..protocol import VibeStartCommand
        cmd = VibeStartCommand(mode="new", description=phase.get("prompt", phase.get("description", "")))
        self.app.send_command(cmd)

    def _save_project_state(self) -> None:
        """Save phase progress to disk."""
        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        state_path = os.path.join(project_dir, '.cynco-project.json')
        try:
            state = {"phases": self._phases, "phase_idx": self._phase_idx}
            with open(state_path, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception:
            pass

    def _load_project_state(self) -> None:
        """Load saved phase progress from disk."""
        project_dir = getattr(self.app, 'project_dir', None) or os.getcwd()
        state_path = os.path.join(project_dir, '.cynco-project.json')
        try:
            if os.path.exists(state_path):
                with open(state_path) as f:
                    state = json.load(f)
                self._phases = state.get("phases", [])
                self._phase_idx = state.get("phase_idx", 0)
        except Exception:
            pass

    def on_input_submitted(self, event: Input.Submitted) -> None:
        """Handle user input — send as vibe.answer or vibe.start."""
        text = event.value.strip()
        if not text:
            return
        event.input.value = ""

        chat = self.query_one("#vibe-chat", ChatPanel)
        chat.add_user_message(text)

        # Show worker animation immediately — engine takes time to respond
        try:
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            worker.start_activity("think" if self._state == "idle" else "search")
        except Exception:
            pass

        if self._state == "idle":
            # Handle "resume" for saved project phases
            if text.lower().strip() == 'resume' and self._phases and self._phase_idx < len(self._phases):
                self._execute_current_phase()
                return
            # Detect mode from user's text
            lower = text.lower()
            continue_signals = ["continue", "finish", "existing", "current", "resume", "pick up", "what's here", "work on"]
            fix_signals = ["fix", "bug", "broken", "error", "crash", "wrong", "not working"]
            if any(s in lower for s in fix_signals):
                mode = "fix"
            elif any(s in lower for s in continue_signals):
                mode = "continue"
            else:
                mode = "new"
            from ..protocol import VibeStartCommand
            cmd = VibeStartCommand(mode=mode, description=text)
            self.app.send_command(cmd)
        elif self._state == "understand":
            # Answer a question
            from ..protocol import VibeAnswerCommand
            cmd = VibeAnswerCommand(question_id=self._current_question_id, answer=text)
            self.app.send_command(cmd)
        elif self._state == "report":
            # Free text after completion — "something else"
            from ..protocol import VibeActionCommand
            cmd = VibeActionCommand(action="something_else", text=text)
            self.app.send_command(cmd)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        """Handle completion screen buttons and just-build button."""
        button_id = event.button.id
        if button_id == "vibe-just-build":
            from ..protocol import VibeActionCommand
            cmd = VibeActionCommand(action="just_build")
            self.app.send_command(cmd)
            return

        # CompletionCard buttons
        action_map = {
            "accept": "accept_suggestion",
            "something-else": "something_else",
            "fix": "fix",
            "done": "done",
        }
        action = action_map.get(button_id, "")
        if action:
            if action == "accept_suggestion" and self._phases and self._phase_idx < len(self._phases):
                # In phase mode, "accept" means advance to next phase
                self._phase_idx += 1
                self._save_project_state()
                self._execute_current_phase()
                return
            # Show animation for actions that trigger engine work
            if action != "done":
                try:
                    worker = self.query_one("#vibe-worker", WorkerAnimation)
                    worker.start_activity("think")
                except Exception:
                    pass
            from ..protocol import VibeActionCommand
            cmd = VibeActionCommand(action=action)
            self.app.send_command(cmd)

    def handle_state_changed(self, event) -> None:
        """Handle vibe.state_changed event from engine."""
        self._state = getattr(event, 'to', 'idle')
        # Update the confidence bar to show current phase
        try:
            bar = self.query_one("#vibe-confidence", ConfidenceBar)
            bar.set_phase(self._state)
        except Exception:
            pass
        try:
            completion = self.query_one("#vibe-completion", CompletionCard)
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            input_widget = self.query_one("#vibe-input", Input)
            just_build = self.query_one("#vibe-just-build", Button)
        except Exception:
            return

        if self._state == "understand":
            completion.remove_class("visible")
            just_build.add_class("visible")
            input_widget.placeholder = "Your answer..."
            input_widget.focus()
        elif self._state == "build":
            completion.remove_class("visible")
            just_build.remove_class("visible")
            worker.start_activity("build")
            input_widget.placeholder = "Building..."
        elif self._state == "report":
            worker.stop_activity()
            just_build.remove_class("visible")
            completion.add_class("visible")
            if self._phases and self._phase_idx < len(self._phases) - 1:
                input_widget.placeholder = "Press 'Yes' to continue to next phase..."
            else:
                input_widget.placeholder = "Or type something else..."
        elif self._state == "idle":
            completion.remove_class("visible")
            just_build.remove_class("visible")
            worker.stop_activity()
            input_widget.placeholder = "Describe what you want to build..."

    def handle_task_complete(self, event) -> None:
        """Handle vibe.task_complete event from engine."""
        try:
            completion = self.query_one("#vibe-completion", CompletionCard)
        except Exception:
            return

        # In phase mode, override suggestion with next phase info
        suggestion = getattr(event, 'suggestion', '')
        if self._phases and self._phase_idx < len(self._phases) - 1:
            next_phase = self._phases[self._phase_idx + 1]
            suggestion = f"Next up: {next_phase['name']} — {next_phase.get('description', '')}"

        completion.set_completion(
            title=getattr(event, 'title', 'Task'),
            analogy=getattr(event, 'analogy', ''),
            files_changed=getattr(event, 'files_changed', []),
            suggestion=suggestion,
            preview_path=getattr(event, 'preview_path', None),
        )

    def handle_confidence_update(self, event) -> None:
        """Handle vibe.confidence_update event from engine."""
        try:
            bar = self.query_one("#vibe-confidence", ConfidenceBar)
        except Exception:
            return
        bar.update_confidence(
            confidence=getattr(event, 'confidence', {}),
            overall=getattr(event, 'overall', 0.0),
            reason=getattr(event, 'reason', ''),
        )

    def handle_question(self, event) -> None:
        """Handle vibe.question event from engine."""
        self._current_question_id = getattr(event, 'question_id', '')
        # Stop the thinking animation — we have a response
        try:
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            worker.stop_activity()
        except Exception:
            pass
        try:
            chat = self.query_one("#vibe-chat", ChatPanel)
            self.query_one("#vibe-input", Input).focus()
        except Exception:
            return
        text = getattr(event, 'text', '')
        options = getattr(event, 'options', [])
        if options:
            options_text = "\n".join(f"  {chr(65+i)}. {opt}" for i, opt in enumerate(options))
            text += f"\n\n{options_text}"
        chat.add_system_message(text)

    def handle_escalation(self, event) -> None:
        """Handle vibe.escalation event — stop worker animation."""
        try:
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            worker.stop_activity()
        except Exception:
            pass

    def handle_project_scanned(self, event) -> None:
        """Handle vibe.project_scanned event — show project summary."""
        try:
            chat = self.query_one("#vibe-chat", ChatPanel)
            summary = getattr(event, 'summary', '')
            file_count = getattr(event, 'file_count', 0)
            languages = getattr(event, 'languages', [])
            if summary:
                header = f"[bold cyan]Project found[/bold cyan]"
                if file_count:
                    lang_str = ', '.join(languages[:3]) if languages else ''
                    header += f" [dim]({file_count} files{', ' + lang_str if lang_str else ''})[/dim]"
                chat.add_system_message(f"{header}\n{summary}")
        except Exception:
            pass

    # ─── Sidebar event handlers ─────────────────────────────────

    def handle_governance_status(self, event) -> None:
        try:
            sidebar = self.query_one("#vibe-sidebar", ContextSidebar)
            sidebar.set_governance(
                health=event.health,
                s3s4=event.s3s4_balance,
                success_rate=event.tool_success_rate,
                stuck=event.stuck_turns,
                suggestion=event.suggestion,
            )
        except Exception:
            pass

    def handle_context_status(self, event) -> None:
        try:
            sidebar = self.query_one("#vibe-sidebar", ContextSidebar)
            sidebar.set_context_stats(
                tokens=getattr(event, "estimated_tokens", 0),
                utilization=getattr(event, "utilization", 0.0),
                context_length=getattr(event, "context_length", 0),
            )
        except Exception:
            pass

    def handle_session_ready(self, event) -> None:
        try:
            sidebar = self.query_one("#vibe-sidebar", ContextSidebar)
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
        except Exception:
            pass

    def handle_tool_start_sidebar(self, event) -> None:
        try:
            sidebar = self.query_one("#vibe-sidebar", ContextSidebar)
            sidebar.log_tool(event.tool_name, status="running")
        except Exception:
            pass

    def handle_tool_complete_sidebar(self, event) -> None:
        try:
            sidebar = self.query_one("#vibe-sidebar", ContextSidebar)
            tool_status = "error" if event.is_error else "ok"
            result_str = str(event.result) if event.result else ""
            sidebar.log_tool(event.tool_name, status=tool_status,
                           preview=result_str[:80])
            # Track files from Read/Glob/Grep — mirrors WorkspaceScreen logic
            if event.tool_name == "Read" and not event.is_error and result_str:
                sidebar.add_file(result_str.split("\n")[0].strip() or "file")
            elif event.tool_name in ("Glob", "Grep") and not event.is_error and result_str:
                for line in result_str.split("\n")[:10]:
                    path = line.strip()
                    if path:
                        sidebar.add_file(path, tool=event.tool_name)
        except Exception:
            pass

    def action_focus_input(self) -> None:
        try:
            self.query_one("#vibe-input", Input).focus()
        except Exception:
            pass

    def action_just_build(self) -> None:
        """Ctrl+J shortcut to skip questions and build immediately."""
        if self._state == "understand":
            from ..protocol import VibeActionCommand
            cmd = VibeActionCommand(action="just_build")
            self.app.send_command(cmd)

    def action_stop_model(self) -> None:
        """Ctrl+X — interrupt the model mid-task."""
        from ..protocol import AbortCommand
        self.app.send_command(AbortCommand())
        try:
            chat = self.query_one("#vibe-chat", ChatPanel)
            chat.add_system_message("[yellow]⏹ Interrupted.[/yellow]")
            worker = self.query_one("#vibe-worker", WorkerAnimation)
            worker.stop_activity()
        except Exception:
            pass

    async def action_quit(self) -> None:
        await self.app.action_quit()
