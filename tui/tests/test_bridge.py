"""Tests for localcode_tui.bridge module."""
import pytest
from localcode_tui.bridge import EngineBridge


class TestEngineBridgeInit:
    def test_default_port(self):
        bridge = EngineBridge()
        assert bridge.port == 9160

    def test_custom_port(self):
        bridge = EngineBridge(port=8080)
        assert bridge.port == 8080

    def test_not_connected_initially(self):
        bridge = EngineBridge()
        assert bridge.connected is False

    def test_on_event_callback(self):
        cb = lambda e: None
        bridge = EngineBridge(on_event=cb)
        assert bridge.on_event is cb

    def test_on_event_default_none(self):
        bridge = EngineBridge()
        assert bridge.on_event is None


class TestEngineBridgeConnect:
    def test_connect_raises_on_no_server(self):
        """connect() should raise ConnectionError when no server is running."""
        import asyncio
        bridge = EngineBridge(port=19999)
        with pytest.raises(ConnectionError, match="Could not connect"):
            asyncio.run(bridge.connect(retries=1, delay=0.01))

    def test_close_when_not_connected(self):
        """close() should not raise when never connected."""
        import asyncio
        bridge = EngineBridge()
        asyncio.run(bridge.close())
        assert bridge.connected is False
