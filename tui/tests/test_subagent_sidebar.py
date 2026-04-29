"""Tests for sub-agent display in context sidebar."""
from localcode_tui.widgets.context_sidebar import ContextSidebar


def test_sidebar_shows_no_agents_by_default():
    sidebar = ContextSidebar()
    sidebar._refresh_content()
    # Should render without errors


def test_sidebar_shows_running_agent():
    sidebar = ContextSidebar()
    sidebar.add_agent("scout-abc123", "scout", "Find auth files", "running", 3, 10, 500)
    assert any(a["id"] == "scout-abc123" for a in sidebar._agents)


def test_sidebar_shows_completed_agent():
    sidebar = ContextSidebar()
    sidebar.add_agent("scout-abc123", "scout", "Find auth files", "completed", 5, 10, 1200)
    assert sidebar._agents[0]["state"] == "completed"


def test_sidebar_updates_existing_agent():
    sidebar = ContextSidebar()
    sidebar.add_agent("scout-abc123", "scout", "Find auth files", "running", 3, 10, 500)
    sidebar.add_agent("scout-abc123", "scout", "Find auth files", "completed", 5, 10, 1200)
    assert len(sidebar._agents) == 1
    assert sidebar._agents[0]["state"] == "completed"


def test_sidebar_limits_agent_display():
    sidebar = ContextSidebar()
    for i in range(15):
        sidebar.add_agent(f"scout-{i:06x}", "scout", f"Task {i}", "completed", 3, 10, 500)
    assert len(sidebar._agents) == 10


def test_sidebar_sets_s2_status():
    sidebar = ContextSidebar()
    sidebar.set_s2_status(gpu_util=0.72, running=1, queued=1)
    assert sidebar._s2_gpu == 0.72
    assert sidebar._s2_running == 1
    assert sidebar._s2_queued == 1
