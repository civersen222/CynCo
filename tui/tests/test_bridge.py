"""Tests for localcode_tui.bridge module."""
import asyncio
import pytest
import websockets.asyncio.server
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

    def test_a_refused_upgrade_raises_ConnectionError_without_retrying(self):
        """The engine answers an unauthorized upgrade with 401.

        Left alone that surfaces as websockets' InvalidStatus escaping connect() —
        a traceback out of app startup, and eleven pointless retries first, since
        a 401 will not become a 200 by waiting. Convert it, and say the status.
        """
        async def run():
            attempts = 0

            def process_request(connection, request):
                nonlocal attempts
                attempts += 1
                return connection.respond(401, "bridge token required\n")

            # asyncio.server, not the legacy one: it is the API the bridge's
            # client half uses, and the only one whose process_request can answer
            # with a real status.
            async with websockets.asyncio.server.serve(
                lambda ws: None, "127.0.0.1", 19998, process_request=process_request
            ):
                bridge = EngineBridge(port=19998)
                with pytest.raises(ConnectionError, match="401"):
                    await bridge.connect(retries=5, delay=0.01)
                return attempts

        assert asyncio.run(run()) == 1

    def test_close_when_not_connected(self):
        """close() should not raise when never connected."""
        import asyncio
        bridge = EngineBridge()
        asyncio.run(bridge.close())
        assert bridge.connected is False
