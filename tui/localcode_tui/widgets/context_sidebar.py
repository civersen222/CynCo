"""Context sidebar -- shows files in context, tool activity, and file preview."""
from textual.widgets import Static
from os.path import basename


class ContextSidebar(Static):
    """Right panel showing context: files read, tool log, file preview."""

    DEFAULT_CSS = """
    ContextSidebar {
        height: 1fr;
        border: solid $accent;
        overflow-y: auto;
        padding: 0 1;
    }
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._files: list[dict] = []  # [{path, size, tool}]
        self._tool_log: list[dict] = []  # [{name, icon, color, preview}]
        self._preview_content: str = ""
        self._preview_path: str = ""
        self._active_workflow = None
        self._active_phase = None
        self._gov_health: str | None = None
        self._gov_s3s4: str = ""
        self._gov_success: float = 1.0
        self._gov_stuck: int = 0
        self._gov_suggestion: str | None = None

        # Memory section
        self._prior_goal: str | None = None
        self._prior_status: str | None = None
        self._prior_date: str | None = None
        self._prior_threads: list[dict] = []
        self._recalled_memories: list[dict] = []
        self._memory_write_log: list[dict] = []  # [{kind, summary}]

        # Session info
        self._session_model: str = ""
        self._session_ctx_len: int = 0
        self._session_start: str = ""
        self._expertise: str = ""
        self._ctx_tokens: int = 0
        self._ctx_utilization: float = 0.0
        # Performance
        self._tok_rate: float = 0.0  # tokens/sec
        self._tok_count: int = 0
        self._tok_start: float = 0.0
        self._gpu_info: str = ""
        # MCP / LSP
        self._mcp_servers: list[dict] = []
        self._lsp_servers: list[dict] = []
        # Todo
        self._todos: list[dict] = []
        # Project
        self._project_path: str = ""
        self._version: str = ""

    def on_mount(self) -> None:
        self._refresh_content()

    def set_governance(self, health: str, s3s4: str, success_rate: float, stuck: int, suggestion: str | None) -> None:
        self._gov_health = health
        self._gov_s3s4 = s3s4
        self._gov_success = success_rate
        self._gov_stuck = stuck
        self._gov_suggestion = suggestion
        self._refresh_content()

    def set_prior_session(self, goal: str, status: str, date_relative: str, open_threads: list[dict]) -> None:
        self._prior_goal = goal
        self._prior_status = status
        self._prior_date = date_relative
        self._prior_threads = open_threads
        self._refresh_content()

    def set_recalled_memories(self, memories: list[dict]) -> None:
        self._recalled_memories = memories
        self._refresh_content()

    def log_memory_write(self, kind: str, summary: str) -> None:
        self._memory_write_log.append({"kind": kind, "summary": summary})
        if len(self._memory_write_log) > 5:
            self._memory_write_log = self._memory_write_log[-5:]
        self._refresh_content()

    def set_session_info(self, model: str, context_length: int, session_start: str, expertise: str = "") -> None:
        self._session_model = model
        self._session_ctx_len = context_length
        self._session_start = session_start
        self._expertise = expertise
        self._refresh_content()

    def set_context_stats(self, tokens: int, utilization: float, context_length: int = 0) -> None:
        self._ctx_tokens = tokens
        self._ctx_utilization = utilization
        if context_length > 0:
            self._session_ctx_len = context_length
        self._refresh_content()

    def on_stream_token(self) -> None:
        """Call on each stream token to track generation speed."""
        import time
        now = time.time()
        if self._tok_start == 0:
            self._tok_start = now
        self._tok_count += 1
        elapsed = now - self._tok_start
        if elapsed > 0.5:
            self._tok_rate = self._tok_count / elapsed
            self._refresh_content()

    def on_stream_complete(self) -> None:
        """Call when generation finishes — reset for next turn."""
        self._tok_count = 0
        self._tok_start = 0.0
        self._refresh_content()

    def set_gpu_info(self, info: str) -> None:
        """Set GPU info string (e.g. 'RTX 4090 · 18.2/24 GB')."""
        self._gpu_info = info
        self._refresh_content()

    def set_lsp_servers(self, servers: list[dict]) -> None:
        self._lsp_servers = servers
        self._refresh_content()

    def set_mcp_servers(self, servers: list[dict]) -> None:
        self._mcp_servers = servers
        self._refresh_content()

    def set_todos(self, todos: list[dict]) -> None:
        self._todos = todos
        self._refresh_content()

    def set_project_info(self, path: str, version: str) -> None:
        self._project_path = path
        self._version = version
        self._refresh_content()

    def set_workflow(self, name: str | None, phase: str | None) -> None:
        self._active_workflow = name
        self._active_phase = phase
        self._refresh_content()

    def add_file(self, path: str, size: str = "", tool: str = "Read") -> None:
        """Track a file that was read into context."""
        # Avoid duplicates
        if not any(f["path"] == path for f in self._files):
            self._files.append({"path": path, "size": size, "tool": tool})
        self._refresh_content()

    def log_tool(self, name: str, status: str = "ok", preview: str = "") -> None:
        """Log a tool execution."""
        icon = {"ok": "\u2713", "error": "\u2717", "running": "\u25b6"}.get(status, "\u25b6")
        color = {"ok": "green", "error": "red", "running": "yellow"}.get(status, "yellow")
        self._tool_log.append({
            "name": name,
            "icon": icon,
            "color": color,
            "preview": preview[:80],
        })
        # Keep last 50 entries
        if len(self._tool_log) > 50:
            self._tool_log = self._tool_log[-50:]
        self._refresh_content()

    def show_preview(self, path: str, content: str) -> None:
        """Show file content in the preview area."""
        self._preview_path = path
        self._preview_content = content[:3000]  # Cap for display
        self._refresh_content()

    def show_file(self, path: str, content: str = "") -> None:
        """Backward-compatible: display a file with its path as header."""
        if not content:
            try:
                with open(path) as f:
                    content = f.read()
            except (FileNotFoundError, PermissionError) as e:
                self.update(f"[red]Cannot read {path}: {e}[/red]")
                return
        self.add_file(path)
        self.show_preview(path, content)

    def show_diff(self, path: str, diff: str) -> None:
        """Show a colored diff in preview."""
        lines = []
        for line in diff.split("\n"):
            if line.startswith("+"):
                lines.append(f"[green]{line}[/green]")
            elif line.startswith("-"):
                lines.append(f"[red]{line}[/red]")
            elif line.startswith("@"):
                lines.append(f"[cyan]{line}[/cyan]")
            else:
                lines.append(line)
        self._preview_path = path
        self._preview_content = "\n".join(lines)
        self._refresh_content()

    def _refresh_content(self) -> None:
        """Re-render the entire sidebar in OpenCode-inspired layout."""
        parts = []

        # ── Session ──
        if self._session_start:
            parts.append(f"[bold]New session[/bold] [dim]\u2014 {self._session_start}[/dim]")
            parts.append(f"  Model: [cyan]{self._session_model}[/cyan] \u00b7 {self._session_ctx_len:,} ctx")
            if self._expertise and self._expertise != "advanced":
                exp_label = {"beginner": "Beginner (guided)", "intermediate": "Intermediate"}.get(self._expertise, self._expertise)
                parts.append(f"  Level: [yellow]{exp_label}[/yellow]")
            parts.append("")

        # ── Context ──
        if self._ctx_tokens > 0 or self._ctx_utilization > 0:
            pct = int(self._ctx_utilization * 100)
            color = "green" if pct < 50 else ("yellow" if pct < 80 else "red")
            parts.append("[bold]Context[/bold]")
            model_tag = f"  [cyan]{self._session_model}[/cyan]" if self._session_model else ""
            if model_tag:
                parts.append(model_tag)
            tokens_line = f"  {self._ctx_tokens:,} tokens"
            if self._session_ctx_len > 0:
                tokens_line += f" / {self._session_ctx_len:,}"
            parts.append(tokens_line)
            parts.append(f"  [{color}]{pct}% used[/{color}]")
            parts.append("")

        # ── Speed ──
        if self._tok_rate > 0 or self._gpu_info:
            parts.append("[bold]Performance[/bold]")
            if self._tok_rate > 0:
                rate = self._tok_rate
                # ASCII speedometer: 0-50 tok/s range
                needle = min(int(rate / 50 * 10), 10)
                gauge = "▁▂▃▄▅▆▇█"
                bar = ""
                for i in range(10):
                    if i < needle:
                        c = "green" if i < 4 else ("yellow" if i < 7 else "red")
                        idx = min(i, len(gauge) - 1)
                        bar += f"[{c}]{gauge[idx]}[/{c}]"
                    else:
                        bar += "[dim]░[/dim]"
                parts.append(f"  {bar} {rate:.1f} tok/s")
            if self._gpu_info:
                parts.append(f"  [dim]{self._gpu_info}[/dim]")
            parts.append("")

        # ── Workflow (if active) ──
        if self._active_workflow:
            parts.append(f"[bold yellow]Workflow: {self._active_workflow}[/bold yellow]")
            parts.append(f"  Phase: [cyan]{self._active_phase}[/cyan]")
            parts.append("")

        # ── VSM Governance ──
        if self._gov_health:
            health_color = {"healthy": "green", "warning": "yellow", "critical": "red"}.get(self._gov_health, "white")
            parts.append("[bold]VSM Governance[/bold]")
            parts.append(f"  Health: [{health_color}]{self._gov_health}[/{health_color}]")
            parts.append(f"  S3/S4: {self._gov_s3s4}")
            parts.append(f"  Tools: {int(self._gov_success * 100)}% success")
            if self._gov_stuck > 0:
                parts.append(f"  [yellow]Stuck: {self._gov_stuck} turns[/yellow]")
            if self._gov_suggestion:
                parts.append(f"  [dim]{self._gov_suggestion}[/dim]")
            parts.append("")

        # ── MCP ──
        parts.append("[bold]MCP[/bold]")
        if self._mcp_servers:
            for s in self._mcp_servers:
                status = s.get("status", "unknown")
                color = {"connected": "green", "failed": "red", "disabled": "dim", "pending": "yellow"}.get(status, "white")
                parts.append(f"  \u2022 {s.get('name', '?')} [{color}]{status.title()}[/{color}]")
        else:
            parts.append("  [dim]No MCP servers configured[/dim]")
        parts.append("")

        # ── LSP ──
        parts.append("[bold]LSP[/bold]")
        if self._lsp_servers:
            for s in self._lsp_servers:
                if s.get("available"):
                    parts.append(f"  \u2022 {s.get('language', '?')}: [green]available[/green]")
                else:
                    parts.append(f"  \u2022 {s.get('language', '?')}: [dim]not found[/dim]")
        else:
            parts.append("  [dim]LSPs activate as files are read[/dim]")
        parts.append("")

        # ── Memory ──
        parts.append("[bold]Memory[/bold]")
        has_memory = False
        if self._prior_goal:
            has_memory = True
            status_color = {"in_progress": "yellow", "complete": "green", "blocked": "red", "abandoned": "dim"}.get(self._prior_status or "", "white")
            # Clean up injection markers — show actual task, not raw system text
            goal_display = self._prior_goal
            if goal_display.startswith("[") or goal_display.startswith("Relevant") or goal_display.startswith("Prior session"):
                goal_display = "Active project"
            parts.append(f'  Prior: "{goal_display}" \u00b7 [{status_color}]{self._prior_status}[/{status_color}] \u00b7 {self._prior_date}')
            if self._prior_threads:
                parts.append("  Open threads:")
                for t in self._prior_threads[:5]:
                    prio_color = {"high": "red", "medium": "yellow", "low": "dim"}.get(t.get("priority", ""), "white")
                    parts.append(f"    [{prio_color}]\u2022 {t.get('priority', '?')}[/{prio_color}] \u00b7 {t.get('description', '')}")
        if self._recalled_memories:
            has_memory = True
            parts.append(f"  Recalled ({len(self._recalled_memories)}):")
            for m in self._recalled_memories[:10]:
                conf = f" [{m.get('confidence', '')}]" if m.get("confidence") else ""
                content = m.get("content", "")[:60]
                parts.append(f"    [dim]\u2022 [{m.get('type', '?')}]{conf}[/dim] {content}")
        if self._memory_write_log:
            has_memory = True
            last = self._memory_write_log[-1]
            parts.append(f"  [dim]Last saved: {last['summary']}[/dim]")
        if not has_memory:
            parts.append("  [dim]No prior context \u2014 fresh session[/dim]")
        parts.append("")

        # ── Todo ──
        parts.append("[bold]\u25bc Todo[/bold]")
        if self._todos:
            for t in self._todos:
                status = t.get("status", "pending")
                icon = {"completed": "[\u2713]", "in_progress": "[\u25b6]", "pending": "[ ]"}.get(status, "[ ]")
                color = {"completed": "green", "in_progress": "yellow", "pending": "white"}.get(status, "white")
                content = t.get("content", "")
                parts.append(f"  [{color}]{icon}[/{color}] {content}")
        else:
            parts.append("  [dim]No tasks[/dim]")
        parts.append("")

        # ── Files in Context ──
        parts.append("[bold]Files in Context[/bold]")
        if self._files:
            for f in self._files[-20:]:
                name = basename(f["path"])
                size = f" [dim]({f['size']})[/dim]" if f.get("size") else ""
                parts.append(f"  [cyan]{name}[/cyan]{size}")
        else:
            parts.append("  [dim]No files yet[/dim]")
        parts.append("")

        # ── Tool Activity ──
        parts.append("[bold]Tool Activity[/bold]")
        if self._tool_log:
            for t in self._tool_log[-15:]:
                preview = f" [dim]{t['preview']}[/dim]" if t["preview"] else ""
                parts.append(f"  [{t['color']}]{t['icon']}[/{t['color']}] {t['name']}{preview}")
        else:
            parts.append("  [dim]No activity yet[/dim]")

        # ── Preview ──
        if self._preview_content:
            parts.append("")
            parts.append(f"[bold]Preview:[/bold] [dim]{basename(self._preview_path)}[/dim]")
            sep = "\u2500" * 30
            parts.append(sep)
            parts.append(self._preview_content)

        # ── Footer: project path + version ──
        parts.append("")
        if self._project_path:
            parts.append(f"[dim]{self._project_path}[/dim]")
        if self._version:
            parts.append(f"  \u2022 [bold]LocalCode[/bold] {self._version}")

        self.update("\n".join(parts))
