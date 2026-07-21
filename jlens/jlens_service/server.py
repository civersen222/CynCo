"""Sidecar HTTP service. POST /readout {"layer": int, "h": [float]*d, "k": int?}
-> {"top": [{"token": str, "p": float}]}. GET /health -> {"ok": true, "layers": [...]}.
Start:  python -m jlens_service.server   (port env JLENS_PORT, default 9163)"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from . import config
from .readout import Readout

READOUT: Readout | None = None


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


def main() -> None:
    global READOUT
    print("[jlens] loading artifacts...")
    READOUT = Readout()
    srv = ThreadingHTTPServer(("127.0.0.1", config.port()), Handler)
    print(f"[jlens] serving on 127.0.0.1:{config.port()} layers={config.layers()}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
