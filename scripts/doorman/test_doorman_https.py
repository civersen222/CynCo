"""The doorman's HTTPS name (2026-11-27, F256). The phone opens CynCo at the PC's own https name, so the
app's waking page knocks on the doorman from an https page, which may not fetch http. `tailscale serve`
gives the doorman an https name and forwards it to 127.0.0.1 only, so the doorman listens there too,
beside the Tailscale address, with one Doorman behind both (engine/dashboard/wake.ts is the caller)."""
import http.client
import json
import os
import socket
import sys
import threading

sys.path.insert(0, os.path.dirname(__file__))
import doorman  # noqa: E402
import journal_bursts  # noqa: E402
from test_doorman import Harness  # noqa: E402

HERE = os.path.dirname(__file__)
TARGETS = os.path.join(HERE, "targets.example.json")
MAIN = "6C:6E:07:2D:AA:00"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def get(host, port, path, headers=None):
    c = http.client.HTTPConnection(host, port, timeout=5)
    c.request("GET", path, headers=headers or {})
    r = c.getresponse()
    body = r.read().decode()
    c.close()
    return r.status, body


class TwoListeners:
    """serve_all on two loopback addresses and one port, as the unit binds the Tailscale address and 127.0.0.1."""

    def __enter__(self):
        self.h = Harness()
        self.port = free_port()
        self.servers = doorman.serve_all(["127.0.0.1", "127.0.0.2"], self.port, self.h.d, page_html="<html>{dashboard}</html>")
        assert [b for b, _ in self.servers] == ["127.0.0.1", "127.0.0.2"]
        threading.Thread(target=self.servers[0][1].serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        for _, s in self.servers:
            s.shutdown()
            s.server_close()


def test_both_addresses_answer_on_one_port_and_share_one_doorman():
    with TwoListeners() as t:
        code, body = get("127.0.0.2", t.port, "/wake?target=main")
        assert code == 200 and json.loads(body)["burstActive"] is True
        code, body = get("127.0.0.1", t.port, "/status?target=main")
        assert code == 200 and json.loads(body)["burstActive"] is True  # the other listener sees the same burst
        code, body = get("127.0.0.1", t.port, "/wake?target=main")
        assert json.loads(body)["burstActive"] is True
        assert len([m for _, m in t.h.sent if m == MAIN]) == 1  # a knock on each listener is still one burst


def test_a_further_address_that_will_not_bind_costs_only_itself(monkeypatch, capsys):
    """A busy 127.0.0.1:9170 must not take the wake on the Tailscale address down with it."""
    real = doorman.serve

    def serve(bind, port, d, page_html=None, knocks_only=False):
        if bind == "127.0.0.2":
            raise OSError(98, "Address already in use")
        return real(bind, port, d, page_html, knocks_only)

    monkeypatch.setattr(doorman, "serve", serve)
    h = Harness()
    port = free_port()
    servers = doorman.serve_all(["127.0.0.1", "127.0.0.2"], port, h.d, page_html="<html></html>")
    try:
        assert [b for b, _ in servers] == ["127.0.0.1"]
        threading.Thread(target=servers[0][1].serve_forever, daemon=True).start()
        code, body = get("127.0.0.1", port, "/wake?target=main")
        assert code == 200 and json.loads(body)["burstActive"] is True
        assert "cannot listen on 127.0.0.2:%d" % port in capsys.readouterr().err
    finally:
        for _, s in servers:
            s.shutdown()
            s.server_close()


def test_the_first_address_must_bind(monkeypatch):
    def serve(bind, port, d, page_html=None, knocks_only=False):
        raise OSError(99, "Cannot assign requested address")

    monkeypatch.setattr(doorman, "serve", serve)
    try:
        doorman.serve_all(["100.110.117.10", "127.0.0.1"], 9170, Harness().d)
        assert False, "expected OSError"
    except OSError:
        pass


def test_a_request_refused_before_its_headers_are_read_is_still_logged(capsys):
    with TwoListeners() as t:
        s = socket.create_connection(("127.0.0.1", t.port), timeout=5)
        s.sendall(b"GET /" + b"x" * 70000 + b" HTTP/1.1\r\n\r\n")  # over the 65536-byte request line: 414 before any header
        data = s.recv(200)
        s.close()
    assert b" 414 " in data
    assert "414" in capsys.readouterr().err


def test_a_wildcard_among_the_addresses_is_refused_before_anything_binds(monkeypatch):
    bound = []
    monkeypatch.setattr(doorman, "serve", lambda *a, **k: bound.append(a))
    for wild in ("0.0.0.0", "::"):
        assert doorman.main(["--targets", TARGETS, "--bind", "127.0.0.1", "--bind", wild]) == 2
        assert doorman.main(["--targets", TARGETS, "--bind", wild, "--bind", "127.0.0.1"]) == 2
    assert bound == []


def test_main_binds_every_address_it_is_given(tmp_path, monkeypatch):
    bound = []

    class S:
        def serve_forever(self):
            return None

    def fake_serve(bind, port, d, page_html=None, knocks_only=False):
        bound.append((bind, port, knocks_only))
        return S()

    monkeypatch.setattr(doorman, "serve", fake_serve)
    rc = doorman.main([
        "--targets", TARGETS, "--bind", "100.110.117.10", "--bind", "127.0.0.1", "--port", "9170",
        "--schedule-file", str(tmp_path / "s" / "schedule.json"), "--bursts-file", str(tmp_path / "s" / "bursts.jsonl"),
    ])
    assert rc == 0
    # the Tailscale address takes the daemon's schedule; the HTTPS name's listener takes knocks only
    assert bound == [("100.110.117.10", 9170, False), ("127.0.0.1", 9170, True)]


def post(host, port, path, body, content_type):
    c = http.client.HTTPConnection(host, port, timeout=5)
    c.request("POST", path, body=body, headers={"Content-Type": content_type} if content_type else {})
    r = c.getresponse()
    data = r.read().decode()
    c.close()
    return r.status, data


SCHEDULE = json.dumps({"target": "main", "times": ["2026-11-28T20:00:00Z"]})


def test_the_https_names_listener_takes_knocks_and_no_writes():
    """Any https page a tailnet browser opens can send to the HTTPS name (F256's review), so it cannot
    change the wake schedule there; it can still knock, which any tailnet device could already do."""
    with TwoListeners() as t:  # 127.0.0.1 is the HTTPS name's listener, 127.0.0.2 stands for the Tailscale address
        assert post("127.0.0.1", t.port, "/schedule", SCHEDULE, "application/json")[0] == 403
        assert t.h.timers == []
        assert get("127.0.0.1", t.port, "/wake?target=main")[0] == 200
        assert get("127.0.0.1", t.port, "/status?target=main")[0] == 200
        code, body = post("127.0.0.2", t.port, "/schedule", SCHEDULE, "application/json")
        assert code == 200 and json.loads(body) == {"ok": True, "count": 1}


def test_a_schedule_must_be_application_json():
    """text/plain, a form or no type: what a page may send cross-site with no CORS preflight."""
    with TwoListeners() as t:
        for ctype in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", None):
            code, _ = post("127.0.0.2", t.port, "/schedule", SCHEDULE, ctype)
            assert code == 415, ctype
        assert t.h.timers == []
        assert post("127.0.0.2", t.port, "/schedule", SCHEDULE, "application/json; charset=utf-8")[0] == 200


def test_a_request_serve_forwards_is_logged_under_the_tailnet_client():
    assert doorman.who_asked("127.0.0.1", {"X-Forwarded-For": "100.119.113.27"}) == "100.119.113.27 via 127.0.0.1"
    # serve appends the client to whatever the request carried: the last entry is serve's
    assert doorman.who_asked("127.0.0.1", {"X-Forwarded-For": "6.6.6.6, 100.119.113.27"}) == "100.119.113.27 via 127.0.0.1"
    assert doorman.who_asked("::1", {"X-Forwarded-For": "fd7a:115c:a1e0::1"}) == "fd7a:115c:a1e0::1 via ::1"


def test_the_header_is_believed_only_from_loopback_and_only_as_an_address():
    assert doorman.who_asked("100.64.0.9", {"X-Forwarded-For": "1.2.3.4"}) == "100.64.0.9"
    for junk in ("", "evil host", '1.2.3.4" "GET /wake?target=main HTTP/1.1', "<script>", "1" * 60):
        assert doorman.who_asked("127.0.0.1", {"X-Forwarded-For": junk}) == "127.0.0.1", junk
    assert doorman.who_asked("127.0.0.1", {}) == "127.0.0.1"
    assert doorman.who_asked("127.0.0.1", None) == "127.0.0.1"


def test_the_request_line_names_the_forwarded_client(capsys):
    with TwoListeners() as t:
        get("127.0.0.1", t.port, "/wake?target=main", {"X-Forwarded-For": "100.119.113.27"})
        get("127.0.0.2", t.port, "/status?target=main")
    err = capsys.readouterr().err
    assert '100.119.113.27 via 127.0.0.1 "GET /wake?target=main HTTP/1.1" 200' in err
    status = [line for line in err.splitlines() if '"GET /status?target=main HTTP/1.1" 200' in line]
    assert len(status) == 1 and " via " not in status[0]  # no forwarded header: the peer alone


def test_the_journal_reader_still_finds_a_knock_logged_with_its_forwarded_client():
    lines = [
        '2026-11-27T18:00:00+00:00 doorman sh[1]: 100.119.113.27 via 127.0.0.1 "GET /wake?target=main HTTP/1.1" 200 -',
        "2026-11-27T18:00:00+00:00 doorman sudo[2]:     root : PWD=/ ; USER=root ; COMMAND=/usr/sbin/etherwake -i enp1s0 6C:6E:07:2D:AA:00",
    ]
    bursts = journal_bursts.parse(lines, {MAIN: "main"})
    assert len(bursts) == 1 and bursts[0]["cause"] == "knock"


def test_the_unit_binds_the_tailscale_address_and_loopback_and_never_a_wildcard():
    with open(os.path.join(HERE, "doorman.service"), encoding="utf-8") as f:
        unit = f.read()
    start = [line for line in unit.splitlines() if line.startswith("ExecStart=")]
    assert len(start) == 1
    assert '--bind "$(tailscale ip -4)" --bind 127.0.0.1' in start[0]
    assert "0.0.0.0" not in start[0] and "::" not in start[0].replace("::1", "")


def test_deploy_serves_the_https_name_on_the_tailnet_only():
    with open(os.path.join(HERE, "deploy.sh"), encoding="utf-8") as f:
        script = f.read()
    assert "tailscale serve --bg --https=443 http://127.0.0.1:9170" in script
    assert "tailscale funnel" not in script.lower()  # Funnel would put the name on the internet
