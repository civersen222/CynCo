"""Sidecar HTTP service. POST /readout {"layer": int, "h": [float]*d, "k": int?}
-> {"top": [{"token": str, "p": float}]}. GET /health -> {"ok": true, "layers": [...]}.
Start:  python -m jlens_service.server   (port env JLENS_PORT, default 9163)

torch and the Readout are imported where they are used, so the module (the
Handler, the server class) loads on a box with neither — the tests need only
the HTTP side; main() still loads the artifacts before serving."""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING
from . import config

if TYPE_CHECKING:
    from .readout import Readout

READOUT: Readout | None = None

# A client's reset or abort of its keep-alive socket. The engine's clients
# fetch with AbortSignal.timeout; an abort resets the socket (Windows sends
# RST), handle_one_request's readline raises, and socketserver's handle_error
# printed a full traceback to stderr for each one — relayed line by line into
# the engine log as "[jlens] …" (operator's log, 2026-10-12/13).
CLIENT_CLOSED = (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive: engine client polls at token cadence

    def _send(self, code: int, obj: dict) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            layers = sorted(READOUT.J.keys()) if READOUT else config.layers()
            self._send(200, {"ok": True, "layers": layers})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/readout":
            return self._send(404, {"error": "not found"})
        try:
            import torch

            req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            top = READOUT.readout(int(req["layer"]), torch.tensor(req["h"]), int(req.get("k", 25)))
            self._send(200, {"top": [{"token": t, "p": p} for t, p in top]})
        except KeyError as e:
            self._send(400, {"error": f"unknown layer or missing field: {e}"})
        except Exception as e:  # malformed input must not kill the sidecar
            print(f"[jlens] readout error: {e}")
            self._send(400, {"error": str(e)})

    def log_message(self, *args):  # quiet
        pass


class JlensServer(ThreadingHTTPServer):
    """HTTP/1.1 keep-alive stays; a client closing its socket under us is one short line, not a traceback."""

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, CLIENT_CLOSED):
            # stderr, flushed, as the traceback this replaces: the engine reads
            # the sidecar over a pipe, where Python block-buffers stdout (8 KiB)
            # — a line printed there sat in the buffer until ~150 resets filled
            # it and was lost at stop() (tests/test_server.py, the pipe test).
            print(f"[jlens] client closed the connection (port {client_address[1]})", file=sys.stderr, flush=True)
            return
        super().handle_error(request, client_address)


def main() -> None:
    global READOUT
    from .readout import Readout

    print("[jlens] loading artifacts...")
    READOUT = Readout()
    srv = JlensServer(("127.0.0.1", config.port()), Handler)
    print(f"[jlens] serving on 127.0.0.1:{config.port()} layers={config.layers()}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
