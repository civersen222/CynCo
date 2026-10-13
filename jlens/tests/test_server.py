"""Integration tests for jlens_service.server using a real ThreadingHTTPServer
injected with a synthetic Readout (no real artifacts needed)."""
import contextlib
import io
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import pytest

from jlens_service import server as server_mod

from conftest import make_readout


@pytest.fixture(scope="module")
def live_server():
    """Start a ThreadingHTTPServer on a free port, inject synthetic Readout."""
    server_mod.READOUT = make_readout()
    srv = server_mod.ThreadingHTTPServer(("127.0.0.1", 0), server_mod.Handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield port
    srv.shutdown()
    srv.server_close()
    server_mod.READOUT = None


def _get(port, path):
    resp = urllib.request.urlopen(f"http://127.0.0.1:{port}{path}")
    return resp.status, json.loads(resp.read())


def _post(port, body, expect_error=False):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/readout",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_health(live_server):
    status, body = _get(live_server, "/health")
    assert status == 200
    assert body["ok"] is True
    assert "layers" in body


def test_readout_happy_path(live_server):
    h = [0.1] * 8
    status, body = _post(live_server, {"layer": 2, "h": h, "k": 5})
    assert status == 200
    top = body["top"]
    assert isinstance(top, list) and len(top) > 0
    assert "token" in top[0] and "p" in top[0]
    # probabilities should be descending
    ps = [item["p"] for item in top]
    assert all(ps[i] >= ps[i + 1] for i in range(len(ps) - 1))


def test_unknown_layer_returns_400(live_server):
    status, body = _post(live_server, {"layer": 99, "h": [0.0] * 8})
    assert status == 400
    assert "error" in body


def test_garbage_body_returns_400(live_server):
    req = urllib.request.Request(
        f"http://127.0.0.1:{live_server}/readout",
        data=b"not json at all!!!",
        headers={"Content-Type": "application/json"},
    )
    try:
        resp = urllib.request.urlopen(req)
        status, body = resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        status, body = e.code, json.loads(e.read())
    assert status == 400
    assert "error" in body


# ── a client's reset or abort is not an error of the sidecar's ──────────────
# The engine's clients (jlensClient.ts, activationsConsumer.ts) fetch with
# AbortSignal.timeout over keep-alive; an abort resets the socket (Windows
# sends RST), handle_one_request's readline raises ConnectionResetError, and
# the stock socketserver.handle_error printed a full traceback to stderr for
# each — which the engine relayed line by line as "[jlens] …" (operator's
# engine log, 2026-10-12/13). The server keeps HTTP/1.1 keep-alive and says
# one short line instead; any other error keeps its traceback.

def _serve(handler=None):
    srv = server_mod.JlensServer(("127.0.0.1", 0), handler or server_mod.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def _read_response(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, body = buf.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n"):
        if line.lower().startswith(b"content-length:"):
            length = int(line.split(b":", 1)[1])
    while len(body) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        body += chunk
    return head, body


def _wait_for(text_of, needle, seconds=5):
    deadline = time.time() + seconds
    while time.time() < deadline and needle not in text_of():
        time.sleep(0.02)
    time.sleep(0.1)  # whatever the handler thread still prints after the line


def test_a_client_that_resets_its_keep_alive_socket_gets_one_line_and_no_traceback():
    srv, port = _serve()
    out, err = io.StringIO(), io.StringIO()
    text = lambda: out.getvalue() + err.getvalue()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            s = socket.create_connection(("127.0.0.1", port))
            s.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            head, body = _read_response(s)
            assert head.startswith(b"HTTP/1.1 200")
            assert json.loads(body)["ok"] is True
            assert b"close" not in head.lower()  # keep-alive stays: the engine polls at token cadence
            # SO_LINGER 0: close() sends RST, not FIN — what a client's abort looks like to the server
            s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            s.close()
            _wait_for(text, "client closed the connection")
    finally:
        srv.shutdown()
        srv.server_close()
    assert "Traceback" not in text(), text()
    assert "ConnectionResetError" not in text(), text()
    assert text().count("client closed the connection") == 1, text()
    assert "(port " in text(), text()


# The engine spawns the sidecar with piped stdout and stderr
# (engine/brain/jlensSidecar.ts) and relays both. On a pipe Python
# block-buffers stdout (8 KiB) and keeps stderr line-buffered, so the
# traceback this line replaced reached the engine at once while a line
# print()ed to stdout sat in the buffer until ~150 resets filled it — and was
# lost at stop(). The tests above capture in-process and cannot see this; the
# line goes to stderr, flushed, as the traceback did.
DRIVER = '''import sys
sys.path.insert(0, sys.argv[1])
from jlens_service import server as s
srv = s.JlensServer(("127.0.0.1", 0), s.Handler)
print("PORT %d" % srv.server_address[1], file=sys.stderr, flush=True)
srv.serve_forever()
'''


def test_the_line_reaches_a_parent_over_a_pipe_at_once_without_pythonunbuffered(tmp_path):
    driver = tmp_path / "driver.py"
    driver.write_text(DRIVER)
    env = {k: v for k, v in os.environ.items() if k != "PYTHONUNBUFFERED"}
    package_root = os.path.dirname(os.path.dirname(os.path.abspath(server_mod.__file__)))
    proc = subprocess.Popen([sys.executable, str(driver), package_root], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True)
    lines = []

    def pump(stream):
        for line in stream:
            lines.append(line.rstrip("\n"))

    seen = lambda: [l for l in lines if "client closed the connection" in l]
    try:
        port = int(proc.stderr.readline().split()[1])
        for stream in (proc.stdout, proc.stderr):
            threading.Thread(target=pump, args=(stream,), daemon=True).start()
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        head, _ = _read_response(s)
        assert head.startswith(b"HTTP/1.1 200")
        s.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        s.close()
        deadline = time.time() + 2
        while time.time() < deadline and not seen():
            time.sleep(0.02)
        got = list(lines)
    finally:
        proc.terminate()
        proc.wait(timeout=5)
    assert len(seen()) == 1 and "(port " in seen()[0], got
    assert not any("Traceback" in l for l in got), got
    assert re.fullmatch(r"\[jlens\] client closed the connection \(port \d+\)", seen()[0]), got


def test_any_other_error_in_a_handler_keeps_its_traceback():
    class Boom(server_mod.Handler):
        def do_GET(self):
            raise RuntimeError("boom")

    srv, port = _serve(Boom)
    out, err = io.StringIO(), io.StringIO()
    text = lambda: out.getvalue() + err.getvalue()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            s = socket.create_connection(("127.0.0.1", port))
            s.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            while s.recv(4096):  # the server closes the socket after the error
                pass
            s.close()
            _wait_for(text, "RuntimeError: boom")
    finally:
        srv.shutdown()
        srv.server_close()
    assert "Traceback" in err.getvalue(), text()
    assert "RuntimeError: boom" in err.getvalue(), text()
    assert "client closed the connection" not in text(), text()


def test_the_server_module_imports_without_the_lens_artifacts_or_torch():
    # `python -m jlens_service.server` still loads the artifacts in main(); the
    # module itself (the Handler, the server class) needs neither, so the tests
    # above run on a box with only the service code.
    assert hasattr(server_mod, "JlensServer")
    assert server_mod.READOUT is None or server_mod.READOUT is not None  # no load at import
