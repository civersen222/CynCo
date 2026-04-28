import pytest
from localcode_tui.widgets.context_sidebar import ContextSidebar


class TestMemorySection:
    def _make_sidebar(self):
        sidebar = ContextSidebar()
        sidebar._files = []
        sidebar._tool_log = []
        sidebar._preview_content = ""
        sidebar._preview_path = ""
        sidebar._active_workflow = None
        sidebar._active_phase = None
        sidebar._gov_health = None
        return sidebar

    def test_set_prior_session_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_prior_session(
            goal="fix edit loop",
            status="in_progress",
            date_relative="2d ago",
            open_threads=[{"priority": "high", "description": "wire summary"}],
        )
        assert sidebar._prior_goal == "fix edit loop"
        assert sidebar._prior_status == "in_progress"
        assert sidebar._prior_date == "2d ago"
        assert len(sidebar._prior_threads) == 1

    def test_set_recalled_memories_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_recalled_memories([
            {"type": "WORKING_SOLUTION", "content": "Use intercept", "confidence": "high"},
        ])
        assert len(sidebar._recalled_memories) == 1
        assert sidebar._recalled_memories[0]["type"] == "WORKING_SOLUTION"

    def test_log_memory_write_appends_to_log(self):
        sidebar = self._make_sidebar()
        sidebar.log_memory_write("handoff", "Saved handoff: fix bug")
        sidebar.log_memory_write("ledger_update", "Updated ledger")
        assert len(sidebar._memory_write_log) == 2

    def test_log_memory_write_capped_at_5(self):
        sidebar = self._make_sidebar()
        for i in range(8):
            sidebar.log_memory_write("handoff", f"Write {i}")
        assert len(sidebar._memory_write_log) == 5

    def test_empty_memory_section_shows_fresh_session(self):
        sidebar = self._make_sidebar()
        assert sidebar._prior_goal is None
        assert len(sidebar._recalled_memories) == 0


class TestSessionSection:
    def _make_sidebar(self):
        sidebar = ContextSidebar()
        sidebar._files = []
        sidebar._tool_log = []
        sidebar._preview_content = ""
        sidebar._preview_path = ""
        sidebar._active_workflow = None
        sidebar._active_phase = None
        sidebar._gov_health = None
        return sidebar

    def test_set_session_info_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_session_info(
            model="qwen3:8b",
            context_length=32768,
            session_start="2026-04-17T10:45:24Z",
        )
        assert sidebar._session_model == "qwen3:8b"
        assert sidebar._session_ctx_len == 32768
        assert sidebar._session_start == "2026-04-17T10:45:24Z"

    def test_set_context_stats_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_context_stats(tokens=12000, utilization=0.37)
        assert sidebar._ctx_tokens == 12000
        assert sidebar._ctx_utilization == 0.37

    def test_set_lsp_servers_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_lsp_servers([
            {"language": "typescript", "available": True},
            {"language": "python", "available": False},
        ])
        assert len(sidebar._lsp_servers) == 2

    def test_set_mcp_servers_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_mcp_servers([
            {"name": "playwright", "status": "connected"},
        ])
        assert len(sidebar._mcp_servers) == 1

    def test_set_project_info_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_project_info(path="/home/user/project", version="0.1.0")
        assert sidebar._project_path == "/home/user/project"
        assert sidebar._version == "0.1.0"

    def test_set_todos_stores_data(self):
        sidebar = self._make_sidebar()
        sidebar.set_todos([
            {"content": "Fix edit loop", "status": "completed"},
            {"content": "Add memory sidebar", "status": "in_progress"},
        ])
        assert len(sidebar._todos) == 2
