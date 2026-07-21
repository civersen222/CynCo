"""Integration tests for jlens_service.server using a real ThreadingHTTPServer
injected with a synthetic Readout (no real artifacts needed)."""
import json
import threading
import urllib.request
import torch
import pytest

from jlens_service import server as server_mod
from jlens_service.readout import Readout
from jlens_service import config


def make_readout(d=8, vocab=16):
    torch.manual_seed(0)
    r = Readout.__new__(Readout)
    r.J = {2: torch.eye(d, dtype=torch.float32)}
    r.wu = torch.randn(vocab, d)
    r.norm_w = torch.ones(d)
    r.id_to_token = {i: f"tok{i}" for i in range(vocab)}
    return r


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
