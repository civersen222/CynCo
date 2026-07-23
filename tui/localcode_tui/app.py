"""LocalCode TUI -- main Textual application."""
from __future__ import annotations
import argparse
import asyncio
from rich.markup import escape
from textual.app import App
from textual.message import Message as TextualMessage

from .config import load_config, save_config
from .bridge import EngineBridge
from .protocol import (
    StreamTokenEvent, StreamThinkingEvent, MessageCompleteEvent, ToolStartEvent,
    ToolCompleteEvent, ToolcallTransportEvent, GovernanceAlertEvent,
    ApprovalRequestEvent, AskRequestEvent, ContextStatusEvent,
    ContextWarningEvent, SessionReadyEvent, SessionErrorEvent,
    FileDiffEvent,
    UserMessageCommand, SlashCommandMsg, WorkflowStatusEvent,
    GovernanceStatusEvent, GovernanceRecommendationEvent,
    SummaryInjectedEvent,
    MemoryRecalledEvent,
    MemoryWrittenEvent,
    ConfigCurrentEvent,
    ConfigUpdatedEvent,
    ToolsListEvent,
    WizardResponseEvent,
    WebSearchResultEvent,
    VibeStateChangedEvent,
    VibeConfidenceUpdateEvent,
    VibeTaskCompleteEvent,
    VibeEscalationEvent,
    VibeProjectScannedEvent,
    VibeQuestionEvent,
    SubAgentSpawnedEvent,
    SubAgentToolEvent,
    SubAgentCompleteEvent,
    SubAgentKilledEvent,
    S2CoordinationEvent,
    SnapshotTakenEvent,
    SnapshotRestoredEvent,
    SkillStatusEvent,
    SkillInstalledEvent,
    SkillListEvent,
    ProfileListEvent,
    ProfileValidationEvent,
    ProfileWrittenEvent,
)


class LocalCodeApp(App):
    """Main LocalCode TUI application."""

    TITLE = "LocalCode"
    SUB_TITLE = "Local AI Coding Assistant"
    CSS_PATH = "styles/theme.tcss"

    BINDINGS = [
        ("ctrl+q", "quit", "Quit"),
        ("ctrl+w", "switch_mode", "Switch Mode"),
        ("escape", "abort_generation", "Abort"),
    ]

    # Custom Textual message for engine events
    class EngineEventReceived(TextualMessage):
        def __init__(self, event) -> None:
            super().__init__()
            self.event = event

    def __init__(self, port: int = 9160, setup: bool = False, project: str | None = None):
        super().__init__()
        self.bridge_port = port
        self.bridge: EngineBridge | None = None
        self.show_setup = setup
        self.project_dir: str | None = project
        self.engine_process = None
        self._engine_job = None  # P1.9: Job Object handle owning the engine tree
        self.config = load_config()
        self._current_message = ""
        self._engine_busy = False  # True between user message send and message.complete
        self._vibe_escalation_lock = asyncio.Lock()

    async def on_mount(self) -> None:
        """Show project picker or connect to running engine."""
        if self.project_dir:
            # Project specified via CLI — try connecting to existing engine
            self.bridge = EngineBridge(port=self.bridge_port, on_event=self._on_engine_event)
            try:
                await self.bridge.connect()
                self.notify("Connected to engine", severity="information")
            except ConnectionError as e:
                self.notify(f"Cannot connect to engine: {e}", severity="error")

            from .screens.workspace import WorkspaceScreen
            self.push_screen(WorkspaceScreen())
        elif self.show_setup:
            from .screens.setup_wizard import SetupWizard
            self.push_screen(SetupWizard())
        else:
            # Show project picker — user selects directory, engine launched automatically
            from .screens.project_picker import ProjectPicker
            self.push_screen(ProjectPicker())

    def _on_engine_event(self, event) -> None:
        """Handle events from the engine bridge (runs on same event loop)."""
        # Post as a Textual message so it's processed in the UI thread properly
        self.post_message(self.EngineEventReceived(event))

    def action_abort_generation(self) -> None:
        """Esc — ask the engine to abort the current generation (no-op when idle)."""
        if not self.bridge or not self._engine_busy:
            return
        from .protocol import AbortCommand
        asyncio.ensure_future(self.bridge.send(AbortCommand()))
        self.notify("Abort requested", severity="warning")

    def _event_dispatch_table(self) -> dict:
        """Map each engine-event dataclass to its handler method.

        session.ready / session.error keep bespoke handling in the receiver
        (notify + sub_title) so they are intentionally NOT in this table.
        """
        return {
            StreamTokenEvent: self._handle_stream_token,
            StreamThinkingEvent: self._handle_stream_thinking,
            MessageCompleteEvent: self._handle_message_complete,
            ToolStartEvent: self._handle_tool_start,
            ToolCompleteEvent: self._handle_tool_complete,
            ToolcallTransportEvent: self._handle_toolcall_transport,
            GovernanceAlertEvent: self._handle_governance_alert,
            GovernanceRecommendationEvent: self._handle_governance_recommendation,
            SnapshotTakenEvent: self._handle_snapshot_taken,
            SnapshotRestoredEvent: self._handle_snapshot_restored,
            ApprovalRequestEvent: self._handle_approval_request,
            AskRequestEvent: self._handle_ask_request,
            ContextStatusEvent: self._handle_context_status,
            ContextWarningEvent: self._handle_context_warning,
            WorkflowStatusEvent: self._handle_workflow_status,
            GovernanceStatusEvent: self._handle_governance_status,
            SummaryInjectedEvent: self._handle_summary_injected,
            MemoryRecalledEvent: self._handle_memory_recalled,
            MemoryWrittenEvent: self._handle_memory_written,
            ConfigCurrentEvent: self._handle_config_current,
            ConfigUpdatedEvent: self._handle_config_updated,
            ToolsListEvent: self._handle_tools_list,
            WizardResponseEvent: self._handle_wizard_response,
            WebSearchResultEvent: self._handle_web_search_result,
            VibeStateChangedEvent: self._handle_vibe_state_changed,
            VibeConfidenceUpdateEvent: self._handle_vibe_confidence_update,
            VibeTaskCompleteEvent: self._handle_vibe_task_complete,
            VibeEscalationEvent: self._handle_vibe_escalation,
            VibeProjectScannedEvent: self._handle_vibe_project_scanned,
            VibeQuestionEvent: self._handle_vibe_question,
            SubAgentSpawnedEvent: self._handle_subagent_spawned,
            SubAgentToolEvent: self._handle_subagent_tool,
            SubAgentCompleteEvent: self._handle_subagent_complete,
            SubAgentKilledEvent: self._handle_subagent_killed,
            S2CoordinationEvent: self._handle_s2_decision,
            FileDiffEvent: self._handle_file_diff,
            ProfileListEvent: self._handle_profile_list,
            ProfileValidationEvent: self._handle_profile_validation,
            ProfileWrittenEvent: self._handle_profile_written,
            SkillStatusEvent: self._handle_skill_status,
            SkillInstalledEvent: self._handle_skill_installed,
            SkillListEvent: self._handle_skill_list,
        }

    def on_local_code_app_engine_event_received(self, message: EngineEventReceived) -> None:
        """Process engine events via Textual's message system."""
        event = message.event
        handler = self._event_dispatch_table().get(type(event))
        if handler is not None:
            handler(event)
            return
        if isinstance(event, SessionReadyEvent):
            self.sub_title = f"Model: {event.model}"
            self.notify(f"Engine ready — model: {event.model}")
            from .protocol import protocol_mismatch_warning
            warn = protocol_mismatch_warning(getattr(event, "protocol_version", None))
            if warn:
                self.notify(warn, severity="warning")
            self._handle_session_ready(event)
        elif isinstance(event, SessionErrorEvent):
            self.notify(f"Engine error: {event.error}", severity="error")
        else:
            # Unhandled event — log it so we can diagnose missing handlers
            event_type = getattr(event, 'type', None) or (event.get('type') if isinstance(event, dict) else None)
            if event_type and event_type not in ('stream.token', 'message.complete'):
                print(f"[app] UNHANDLED event: type={event_type} class={type(event).__name__}")

    def _handle_file_diff(self, event) -> None:
        """Route a structured file.diff to the vibe screen's diff view (Task 7 fills it in)."""
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen) and hasattr(self.screen, "handle_file_diff"):
            self.screen.handle_file_diff(event)

    def _handle_stream_token(self, event: StreamTokenEvent) -> None:
        self._engine_busy = True  # resync if generation started outside send_message
        self._current_message += event.text
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.add_assistant_token(event.text)
        except Exception:
            pass
        # Track token rate for speedometer
        try:
            from .widgets.context_sidebar import ContextSidebar
            sidebar = self.query_one(ContextSidebar)
            sidebar.on_stream_token()
        except Exception:
            pass

    def _handle_stream_thinking(self, event: StreamThinkingEvent) -> None:
        """Reasoning tokens are generation too — feed the speedometer (not the chat)."""
        try:
            from .widgets.context_sidebar import ContextSidebar
            sidebar = self.query_one(ContextSidebar)
            sidebar.on_stream_token()
        except Exception:
            self.log("[stream.thinking] no sidebar to update")

    def _handle_message_complete(self, event: MessageCompleteEvent) -> None:
        self._engine_busy = False
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.finish_streaming()
        except Exception:
            pass
        self._current_message = ""
        # Reset speedometer for next turn
        try:
            from .widgets.context_sidebar import ContextSidebar
            sidebar = self.query_one(ContextSidebar)
            sidebar.on_stream_complete()
        except Exception:
            pass
        # Stop worker animation
        try:
            from .screens.workspace import WorkspaceScreen
            from .widgets import WorkerAnimation
            if isinstance(self.screen, WorkspaceScreen):
                worker = self.screen.query_one("#worker-anim", WorkerAnimation)
                worker.stop_activity()
        except Exception:
            pass
        # Route to workspace for project checkpoints
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                if hasattr(self.screen, "_project_phases") and self.screen._project_phases:
                    self.screen.handle_project_checkpoint()
        except Exception:
            pass

    def _handle_tool_start(self, event: ToolStartEvent) -> None:
        try:
            from .widgets import ToolActivity
            activity = self.query_one(ToolActivity)
            activity.start_tool(event.tool_id, event.tool_name)
        except Exception:
            pass
        try:
            from .screens.workspace import WorkspaceScreen
            from .widgets import WorkerAnimation
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_tool_start(event)
                worker = self.screen.query_one("#worker-anim", WorkerAnimation)
                worker.advance_progress()
        except Exception:
            pass
        # Vibe loop: show tool call in chat + update sidebar + worker
        try:
            from .screens.vibe_loop import VibeLoopScreen
            from .widgets import WorkerAnimation, ChatPanel
            if isinstance(self.screen, VibeLoopScreen):
                chat = self.screen.query_one("#vibe-chat", ChatPanel)
                chat.add_system_message(f"[dim]\u25b6 Running tool: [bold]{event.tool_name}[/bold][/dim]")
                worker = self.screen.query_one("#vibe-worker", WorkerAnimation)
                worker.start_activity("build")
                self.screen.handle_tool_start_sidebar(event)
        except Exception:
            pass

    def _handle_tool_complete(self, event: ToolCompleteEvent) -> None:
        try:
            from .widgets import ToolActivity
            activity = self.query_one(ToolActivity)
            activity.complete_tool(event.tool_id)
        except Exception:
            pass
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_tool_complete(event)
        except Exception as e:
            print(f"[app] ERROR in handle_tool_complete (workspace): {e}")
        # Vibe loop: show tool result in chat + update sidebar
        try:
            from .screens.vibe_loop import VibeLoopScreen
            from .widgets import ChatPanel
            if isinstance(self.screen, VibeLoopScreen):
                chat = self.screen.query_one("#vibe-chat", ChatPanel)
                status = "[red]\u2717[/red]" if event.is_error else "[green]\u2713[/green]"
                result_preview = str(event.result)[:200] if event.result else ""
                chat.add_system_message(f"[dim]{status} Tool complete: {result_preview}[/dim]")
                self.screen.handle_tool_complete_sidebar(event)
        except Exception:
            pass

    def _handle_toolcall_transport(self, event: ToolcallTransportEvent) -> None:
        """Tool-call repair ladder observability (P1.8)."""
        if event.stage in ("discarded", "regex_fallback"):
            # Visible warning — the model's tool call was dropped or salvaged via regex
            try:
                from .widgets import ChatPanel
                chat = self.query_one(ChatPanel)
                parts = ["\u26a0 tool call", event.tool_name, event.stage]
                msg = " ".join(p for p in parts if p)
                if event.detail:
                    msg += f": {event.detail}"
                chat.add_system_message(f"[yellow]{msg}[/yellow]")
            except Exception:
                pass
        else:
            # repaired / retried — debug log only, no chat noise
            try:
                self.log(f"[toolcall.transport] {event.stage} {event.tool_name}: {event.detail}")
            except Exception:
                pass

    def _handle_governance_alert(self, event: GovernanceAlertEvent) -> None:
        """Algedonic governance alerts (P1.1): critical/high are user-visible, rest log-only."""
        label = f"{event.source}: {event.message}" if event.source else event.message
        if event.severity in ("critical", "high"):
            try:
                from .widgets import ChatPanel
                chat = self.query_one(ChatPanel)
                style = "red" if event.severity == "critical" else "yellow"
                # escape(): alert text may contain brackets ([Errno 2], list[str])
                # that Rich would parse as markup and raise MarkupError on.
                chat.add_system_message(f"[{style}]\u26a0 {escape(label)}[/{style}]")
            except Exception:
                try:
                    self.log(f"[governance.alert] (no chat panel) [{event.severity}] {label}")
                except Exception:
                    pass
        else:
            # low / medium — debug log only, no chat noise
            try:
                self.log(f"[governance.alert] [{event.severity}] {label}")
            except Exception:
                pass

    def _handle_governance_recommendation(self, event: GovernanceRecommendationEvent) -> None:
        """S5 warning-tier recommendation (not enforced) — surface in chat."""
        label = f"{event.title}: {event.description}" if event.title else event.description
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.add_system_message(f"[yellow]\u26a0 S5 recommends \u2014 {escape(label)}[/yellow]")
        except Exception:
            self.log(f"[governance.recommendation] (no chat panel) {label}")

    def _handle_snapshot_taken(self, event: SnapshotTakenEvent) -> None:
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.add_system_message(
                f"[dim]\u25cf Snapshot: {event.files_changed} file(s) "
                f"(+{event.additions}/-{event.deletions}) \u2014 /undo to revert[/dim]"
            )
        except Exception:
            self.log(f"[snapshot.taken] (no chat panel) {event.files_changed} files")

    def _handle_snapshot_restored(self, event: SnapshotRestoredEvent) -> None:
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.add_system_message(
                f"[yellow]\u21a9 Restored snapshot {event.hash[:8]} ({event.files_changed} file(s))[/yellow]"
            )
        except Exception:
            self.log(f"[snapshot.restored] (no chat panel) {event.hash}")

    def _handle_approval_request(self, event: ApprovalRequestEvent) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                asyncio.ensure_future(self.screen.handle_approval_request(event))
                return
        except Exception:
            pass
        # Fallback: handle at app level using callback pattern
        from .widgets import ApprovalDialog

        dialog = ApprovalDialog(
            tool_name=event.tool_name,
            description=event.description,
            risk=event.risk,
        )

        def on_result(approved: bool | None) -> None:
            if self.bridge:
                from .protocol import ApprovalResponseCommand
                # Map None → False (user dismissed dialog)
                approved_value = approved if approved is not None else False
                asyncio.ensure_future(self.bridge.send(ApprovalResponseCommand(
                    request_id=event.request_id,
                    approved=approved_value,
                )))

        self.push_screen(dialog, on_result)

    def _handle_ask_request(self, event: AskRequestEvent) -> None:
        """Engine AskUser tool: show the question, send the answer back."""
        from .widgets.ask_dialog import AskDialog

        def on_result(answer: str | None) -> None:
            if self.bridge:
                from .protocol import AskAnswerCommand
                asyncio.ensure_future(self.bridge.send(
                    AskAnswerCommand(request_id=event.request_id, answer=answer or "")
                ))

        self.push_screen(AskDialog(event.question, event.options), on_result)

    def _handle_context_status(self, event: ContextStatusEvent) -> None:
        try:
            from .widgets import ContextBar
            bar = self.query_one(ContextBar)
            bar.utilization = event.utilization
        except Exception:
            pass
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_context_status(event)
        except Exception:
            pass
        try:
            from .screens.vibe_loop import VibeLoopScreen
            if isinstance(self.screen, VibeLoopScreen):
                self.screen.handle_context_status(event)
        except Exception:
            pass

    def _handle_session_ready(self, event) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_session_ready(event)
        except Exception:
            pass
        try:
            from .screens.vibe_loop import VibeLoopScreen
            if isinstance(self.screen, VibeLoopScreen):
                self.screen.handle_session_ready(event)
        except Exception:
            pass
        # Fetch GPU info from Ollama /api/ps
        import asyncio
        async def fetch_gpu():
            try:
                import json
                from urllib.request import urlopen
                data = json.loads(urlopen("http://localhost:11434/api/ps", timeout=3).read())
                models = data.get("models", [])
                if models:
                    m = models[0]
                    size_gb = m.get("size_vram", 0) / (1024**3)
                    name = m.get("name", "?")
                    gpu_str = f"{name} · {size_gb:.1f} GB VRAM"
                    from .widgets.context_sidebar import ContextSidebar
                    try:
                        sidebar = self.query_one(ContextSidebar)
                        sidebar.set_gpu_info(gpu_str)
                    except Exception:
                        pass
            except Exception:
                pass
        asyncio.ensure_future(fetch_gpu())

    def _handle_context_warning(self, event: ContextWarningEvent) -> None:
        self.notify(f"Context warning: {event.message}", severity="warning")

    def _handle_governance_status(self, event: GovernanceStatusEvent) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_governance_status(event)
        except Exception:
            pass
        try:
            from .screens.vibe_loop import VibeLoopScreen
            if isinstance(self.screen, VibeLoopScreen):
                self.screen.handle_governance_status(event)
        except Exception:
            pass

    def _handle_summary_injected(self, event: SummaryInjectedEvent) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_summary_injected(event)
        except Exception:
            pass

    def _handle_memory_recalled(self, event) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_memory_recalled(event)
        except Exception:
            pass

    def _handle_memory_written(self, event) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_memory_written(event)
        except Exception:
            pass

    def _handle_config_current(self, event) -> None:
        from .screens.settings import SettingsScreen
        if isinstance(self.screen, SettingsScreen):
            self.screen.handle_config_current(event)

    def _handle_config_updated(self, event) -> None:
        from .screens.settings import SettingsScreen
        if isinstance(self.screen, SettingsScreen):
            self.screen.handle_config_updated(event)

    def _handle_tools_list(self, event) -> None:
        from .screens.settings import SettingsScreen
        if isinstance(self.screen, SettingsScreen):
            self.screen.handle_tools_list(event)

    def _handle_profile_list(self, event) -> None:
        from .screens.settings import SettingsScreen
        from .screens.profile_wizard import ProfileWizard
        if isinstance(self.screen, SettingsScreen) and hasattr(self.screen, 'handle_profile_list'):
            self.screen.handle_profile_list(event)
        elif isinstance(self.screen, ProfileWizard) and hasattr(self.screen, 'handle_profile_list'):
            self.screen.handle_profile_list(event)
        else:
            self.log(f"[profile.list] {len(event.profiles)} profile(s) (no active handler)")

    def _handle_profile_validation(self, event) -> None:
        from .screens.profile_wizard import ProfileWizard
        if isinstance(self.screen, ProfileWizard) and hasattr(self.screen, 'handle_profile_validation'):
            self.screen.handle_profile_validation(event)
        else:
            status = "ok" if event.ok else f"errors: {event.errors}"
            self.log(f"[profile.validation] {status} (no active handler)")

    def _handle_profile_written(self, event) -> None:
        from .screens.profile_wizard import ProfileWizard
        if isinstance(self.screen, ProfileWizard) and hasattr(self.screen, 'handle_profile_written'):
            self.screen.handle_profile_written(event)
        else:
            self.notify(f"Profile '{event.name}' saved", severity="information")
            self.log(f"[profile.written] name={event.name} path={event.path}")

    def _handle_wizard_response(self, event) -> None:
        from .screens.profile_wizard import ProfileWizard
        from .screens.project_wizard import ProjectWizard
        from .screens.workspace import WorkspaceScreen
        if isinstance(self.screen, ProfileWizard):
            self.screen.handle_wizard_response(event)
        elif isinstance(self.screen, ProjectWizard):
            self.screen.handle_wizard_response(event)
        elif isinstance(self.screen, WorkspaceScreen):
            self.screen.handle_wizard_response(event)

    def _handle_web_search_result(self, event) -> None:
        from .screens.project_wizard import ProjectWizard
        if isinstance(self.screen, ProjectWizard):
            self.screen.handle_search_result(event)

    # ─── Vibe Loop Event Handlers ─────────────────────────────────

    def _handle_vibe_state_changed(self, event: VibeStateChangedEvent) -> None:
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen):
            self.screen.handle_state_changed(event)

    def _handle_vibe_confidence_update(self, event: VibeConfidenceUpdateEvent) -> None:
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen):
            self.screen.handle_confidence_update(event)

    def _handle_vibe_task_complete(self, event: VibeTaskCompleteEvent) -> None:
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen):
            self.screen.handle_task_complete(event)

    def _handle_vibe_escalation(self, event: VibeEscalationEvent) -> None:
        async def handle():
            # Serialize dialogs — concurrent push_screen_wait calls race
            async with self._vibe_escalation_lock:
                from .widgets.escalation_dialog import EscalationDialog
                dialog = EscalationDialog(
                    problem=event.problem,
                    tried=event.tried,
                    proposal=event.proposal,
                    request_id=event.request_id,
                )
                action = await self.push_screen_wait(dialog)
                from .protocol import VibeEscalationResponseCommand
                cmd = VibeEscalationResponseCommand(
                    request_id=event.request_id,
                    action=action or "skip",
                )
                self.send_command(cmd)
        asyncio.ensure_future(handle())

    def _handle_vibe_project_scanned(self, event: VibeProjectScannedEvent) -> None:
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen):
            self.screen.handle_project_scanned(event)

    def _handle_vibe_question(self, event: VibeQuestionEvent) -> None:
        from .screens.vibe_loop import VibeLoopScreen
        if isinstance(self.screen, VibeLoopScreen):
            self.screen.handle_question(event)

    # ─── Sub-Agent Event Handlers ─────────────────────────────────

    def _get_sidebar(self):
        """Find the context sidebar on the current screen (works for both WorkspaceScreen and VibeLoopScreen)."""
        from .widgets.context_sidebar import ContextSidebar
        try:
            return self.screen.query_one(ContextSidebar)
        except Exception:
            return None

    def _handle_subagent_spawned(self, event: SubAgentSpawnedEvent) -> None:
        sidebar = self._get_sidebar()
        if sidebar:
            sidebar.add_agent(event.agent_id, event.persona, event.task, "running", 0, 10, 0)
            sidebar.log_tool(f"SubAgent:{event.persona}", "running", event.task[:60])

    def _handle_subagent_tool(self, event: SubAgentToolEvent) -> None:
        sidebar = self._get_sidebar()
        if sidebar:
            tool_status = "ok" if event.status == "success" else event.status
            sidebar.log_tool(f"  {event.agent_id[:12]}:{event.tool_name}", tool_status, event.preview[:40])

    def _handle_subagent_complete(self, event: SubAgentCompleteEvent) -> None:
        sidebar = self._get_sidebar()
        if sidebar:
            state = "completed" if event.success else "failed"
            sidebar.add_agent(event.agent_id, event.persona, event.task, state, event.turns, event.turns, event.tokens_used)

    def _handle_subagent_killed(self, event: SubAgentKilledEvent) -> None:
        sidebar = self._get_sidebar()
        if sidebar:
            sidebar.add_agent(event.agent_id, event.persona, event.task, "killed", 0, 0, 0)

    def _handle_s2_decision(self, event: S2CoordinationEvent) -> None:
        sidebar = self._get_sidebar()
        if sidebar:
            running = sum(1 for a in getattr(sidebar, "_agents", []) if a.get("state") == "running")
            sidebar.set_s2_status(event.gpu_util, running, event.queue_depth)

    def _handle_workflow_status(self, event: WorkflowStatusEvent) -> None:
        try:
            from .screens.workspace import WorkspaceScreen
            if isinstance(self.screen, WorkspaceScreen):
                self.screen.handle_workflow_status(event)
            else:
                print(f"[app] workflow.status received but screen is {type(self.screen).__name__}, not WorkspaceScreen")
        except Exception as e:
            print(f"[app] ERROR in _handle_workflow_status: {e}")

    def _handle_skill_status(self, event: SkillStatusEvent) -> None:
        """Result of a /skill new|install|remove operation."""
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            style = "green" if event.ok else "red"
            mark = "\u2713" if event.ok else "\u2717"
            chat.add_system_message(f"[{style}]{mark} skill {escape(event.action)}: {escape(event.message)}[/{style}]")
        except Exception:
            self.log(f"[skill.status] {event.action} ok={event.ok} {event.message}")

    def _handle_skill_installed(self, event: SkillInstalledEvent) -> None:
        """A skill became available — refresh nothing, just acknowledge."""
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            chat.add_system_message(f"[dim]\u25cf skill available: [bold]{escape(event.name)}[/bold] ({escape(event.source)})[/dim]")
        except Exception:
            self.log(f"[skill.installed] {event.name} ({event.source})")

    def _handle_skill_list(self, event: SkillListEvent) -> None:
        """Response to /skill list — render the catalogue in chat."""
        try:
            from .widgets import ChatPanel
            chat = self.query_one(ChatPanel)
            if not event.skills:
                chat.add_system_message("[dim]No skills installed. Use /skill install <owner>/<repo> or /skill new <name>.[/dim]")
                return
            lines = "\n".join(
                f"  \u2022 [bold]{escape(str(s.get('name', '')))}[/bold] ({escape(str(s.get('source', '')))}) \u2014 {escape(str(s.get('description', '')))}"
                for s in event.skills
            )
            chat.add_system_message(f"[cyan]Skills:[/cyan]\n{lines}")
        except Exception as e:
            self.log(f"[skill.list] render failed: {e}")

    def send_message(self, text: str) -> None:
        """Send a user message to the engine."""
        if self.bridge and self.bridge.connected:
            self._engine_busy = True
            asyncio.ensure_future(self.bridge.send(UserMessageCommand(text=text)))
        else:
            self.notify("Not connected to engine", severity="error")

    def send_command(self, cmd) -> None:
        """Send any protocol command to the engine."""
        if self.bridge and self.bridge.connected:
            asyncio.ensure_future(self.bridge.send(cmd))
        else:
            self.notify("Not connected to engine", severity="error")

    def send_raw_command(self, json_str: str) -> None:
        """Send a raw JSON command string to the engine via WebSocket."""
        if self.bridge and self.bridge.connected:
            asyncio.ensure_future(self.bridge.send_raw(json_str))
        else:
            self.notify("Not connected to engine", severity="error")

    def switch_model(self, model: str) -> None:
        """Switch the active model and update config."""
        self.config.model = model
        self.sub_title = f"Model: {model}"
        save_config(self.config)
        if self.bridge and self.bridge.connected:
            asyncio.ensure_future(
                self.bridge.send(SlashCommandMsg(command="/model", args=model))
            )

    def action_switch_mode(self) -> None:
        """Toggle between guided and workspace modes."""
        current = self.screen
        from .screens.workspace import WorkspaceScreen
        from .screens.guided import GuidedScreen
        if isinstance(current, WorkspaceScreen):
            self.switch_screen(GuidedScreen())
        else:
            self.switch_screen(WorkspaceScreen())

    async def action_quit(self) -> None:
        """Clean shutdown — send session.end, disconnect bridge, kill engine."""
        if self.bridge:
            await self.bridge.send_session_end()
            await self.bridge.close()
        if self.engine_process:
            try:
                self.engine_process.terminate()
                self.engine_process.wait(timeout=5)
            except Exception:
                try:
                    self.engine_process.kill()
                except Exception:
                    pass
        # P1.9: final sweep — terminate() above only reaches the shell;
        # closing the job kills anything left in the tree (llama-server).
        from .job_object import close_job
        close_job(getattr(self, '_engine_job', None))
        self._engine_job = None
        self.exit()


def main():
    parser = argparse.ArgumentParser(description="LocalCode TUI")
    parser.add_argument("--port", type=int, default=9160)
    parser.add_argument("--setup", action="store_true")
    parser.add_argument("--project", "-p", type=str, default=None, help="Project directory to open directly (skips project picker)")
    args = parser.parse_args()

    app = LocalCodeApp(port=args.port, setup=args.setup, project=args.project)
    app.run()


if __name__ == "__main__":
    main()
