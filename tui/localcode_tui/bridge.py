"""WebSocket bridge to the LocalCode TypeScript engine.

Connects to ws://localhost:{port}, sends commands, receives events.
"""
from __future__ import annotations
import asyncio
import json
from typing import Callable, Optional, Any
import websockets
from websockets.asyncio.client import connect

from .protocol import parse_event, serialize_command


class EngineBridge:
    """WebSocket client that connects to the TS engine."""

    def __init__(self, port: int = 9160, on_event: Optional[Callable] = None):
        self.port = port
        self.on_event = on_event
        self._ws: Any = None
        self._connected = False
        self._receive_task: Optional[asyncio.Task] = None

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self, retries: int = 10, delay: float = 0.5) -> None:
        """Connect to the engine with retry logic."""
        for attempt in range(retries):
            try:
                self._ws = await connect(f"ws://localhost:{self.port}")
                self._connected = True
                self._receive_task = asyncio.create_task(self._receive_loop())
                return
            except (ConnectionRefusedError, OSError):
                if attempt < retries - 1:
                    await asyncio.sleep(delay)
        raise ConnectionError(f"Could not connect to engine on port {self.port}")

    async def _receive_loop(self) -> None:
        """Listen for events from the engine."""
        try:
            async for message in self._ws:
                event = parse_event(message)
                if self.on_event:
                    self.on_event(event)
        except websockets.exceptions.ConnectionClosed:
            self._connected = False

    async def send(self, command) -> None:
        """Send a command to the engine."""
        if self._ws and self._connected:
            await self._ws.send(serialize_command(command))

    async def send_raw(self, json_str: str) -> None:
        """Send a raw JSON string to the engine without serialization."""
        if self._ws and self._connected:
            await self._ws.send(json_str)

    async def send_session_end(self) -> None:
        """Send session.end command and wait for it to be delivered before closing."""
        if self._ws and self._connected:
            from .protocol import SessionEndCommand, serialize_command
            try:
                await self._ws.send(serialize_command(SessionEndCommand()))
                # Give the engine a moment to process and write the handoff
                import asyncio
                await asyncio.sleep(0.5)
            except Exception:
                pass  # Best-effort — don't block quit on send failure

    async def close(self) -> None:
        """Close the connection."""
        if self._receive_task:
            self._receive_task.cancel()
        if self._ws:
            await self._ws.close()
        self._connected = False
