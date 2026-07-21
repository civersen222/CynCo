"""Integration tests for jlens_service.server using a real ThreadingHTTPServer
injected with a synthetic Readout (no real artifacts needed)."""
import json
import threading
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
