"""Tool activity display -- shows active tool executions."""
from textual.widgets import Static
from textual.reactive import reactive


class ToolActivity(Static):
    """Displays currently running tools."""

    active_tools: reactive[dict] = reactive(dict, layout=True)

    DEFAULT_CSS = """
    ToolActivity {
        height: auto;
        max-height: 5;
        background: $surface;
        padding: 0 1;
    }
    """

    def watch_active_tools(self, tools: dict) -> None:
        if not tools:
            self.update("[dim]No active tools[/dim]")
            return
        lines = []
        for tool_id, info in tools.items():
            name = info.get("name", "unknown")
            status = info.get("status", "running")
            icon = "\u27f3" if status == "running" else "\u2713"
            lines.append(f"  {icon} {name}")
        self.update("\n".join(lines))

    def start_tool(self, tool_id: str, tool_name: str) -> None:
        tools = dict(self.active_tools)
        tools[tool_id] = {"name": tool_name, "status": "running"}
        self.active_tools = tools

    def complete_tool(self, tool_id: str) -> None:
        tools = dict(self.active_tools)
        if tool_id in tools:
            del tools[tool_id]
        self.active_tools = tools
