"""Esc abort must be a no-op while the engine is idle (review-minors fix)."""
import asyncio

from localcode_tui.app import LocalCodeApp
from localcode_tui.protocol import MessageCompleteEvent


class FakeBridge:
    def __init__(self):
        self.connected = True
        self.sent = []

    async def send(self, cmd):
        self.sent.append(cmd)


def test_abort_noop_when_idle():
    app = LocalCodeApp()
    app.bridge = FakeBridge()
    app._engine_busy = False
    app.action_abort_generation()  # returns before scheduling anything
    assert app.bridge.sent == []


def test_abort_sends_when_busy():
    app = LocalCodeApp()
    app.bridge = FakeBridge()
    app._engine_busy = True
    app.notify = lambda *a, **k: None  # avoid Textual internals off-screen

    async def run():
        app.action_abort_generation()
        await asyncio.sleep(0)  # let ensure_future task run

    asyncio.run(run())
    assert len(app.bridge.sent) == 1
    assert app.bridge.sent[0].type == "abort"


def test_send_message_sets_busy():
    app = LocalCodeApp()
    app.bridge = FakeBridge()
    assert app._engine_busy is False

    async def run():
        app.send_message("hello")
        await asyncio.sleep(0)

    asyncio.run(run())
    assert app._engine_busy is True


def test_message_complete_clears_busy():
    app = LocalCodeApp()
    app._engine_busy = True
    app._handle_message_complete(MessageCompleteEvent())
    assert app._engine_busy is False
