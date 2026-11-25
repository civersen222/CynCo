"""Tests for the project picker engine-launch wiring.

Regression coverage for the 2026-07-02 live-session breakage: the picker
forwarded the TUI's own config.yml model as LOCALCODE_MODEL, letting a stale
TUI config silently override the engine profile.
"""
from dataclasses import dataclass

from localcode_tui.screens.project_picker import (
    build_engine_env,
    image_of_pid,
    listening_pids,
    read_engine_log_tail,
    stop_stale_engine,
)


@dataclass
class FakeConfig:
    model: str = "stale-model:latest"
    context_length: int = 2048


class TestBuildEngineEnv:
    def test_does_not_forward_tui_config_model(self):
        """The TUI's config.yml model must never become LOCALCODE_MODEL."""
        env = build_engine_env({"PATH": "/usr/bin"}, FakeConfig())
        assert "LOCALCODE_MODEL" not in env

    def test_explicit_env_override_passes_through(self):
        env = build_engine_env(
            {"LOCALCODE_MODEL": "user-choice", "PATH": "/usr/bin"}, FakeConfig()
        )
        assert env["LOCALCODE_MODEL"] == "user-choice"

    def test_explicit_context_length_passes_through(self):
        env = build_engine_env({"LOCALCODE_CONTEXT_LENGTH": "65536"}, FakeConfig())
        assert env["LOCALCODE_CONTEXT_LENGTH"] == "65536"

    def test_base_env_not_mutated(self):
        base = {"PATH": "/usr/bin"}
        env = build_engine_env(base, FakeConfig())
        env["EXTRA"] = "x"
        assert "EXTRA" not in base

    def test_works_without_app_config(self):
        env = build_engine_env({"PATH": "/usr/bin"}, None)
        assert env == {"PATH": "/usr/bin"}


class TestReadEngineLogTail:
    def test_returns_last_lines(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("\n".join(f"line {i}" for i in range(20)) + "\n")
        tail = read_engine_log_tail(str(log), max_lines=3)
        assert tail == "line 17\nline 18\nline 19"

    def test_short_file_returned_whole(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("only line\n")
        assert read_engine_log_tail(str(log)) == "only line"

    def test_missing_file(self, tmp_path):
        assert read_engine_log_tail(str(tmp_path / "nope.log")) == "(no engine log found)"

    def test_empty_file(self, tmp_path):
        log = tmp_path / ".cynco-engine.log"
        log.write_text("")
        assert read_engine_log_tail(str(log)) == "(engine log is empty)"


# F255, the port form: the picker cleared the bridge port by killing the pid of every netstat line that held
# ":<port>" anywhere (port 9160 matched :91600, :19160 and an IPv6 address with 9160 as a group), whatever process
# that was. Now only exactly the port, and only an engine (bun.exe) is killed; anything else is named and left.
#
# The engine's listener here is on 65531, and the stop case that asks about another port asks about 916: nothing on
# this PC serves either, and every pid is 2,000,000,000 or above, numbers no process can have. Were the injected `run`
# ever skipped, the real netstat, tasklist and taskkill would find nothing to end on those ports. (It used 9160, the
# live bridge port, whose real listener is a bun.exe, and 4242.) No stop case asks about 9160. The rows on 19160,
# 91600 and the IPv6 address holding 9160 as a group are what the substring match took for port 9160 (the pure
# listing cases), and the last two are what it takes for 916.
PORT = 65531
PID = "2000000000"
NETSTAT = "\r\n".join([
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:65531        0.0.0.0:0              LISTENING       2000000000",
    "  TCP    [::1]:65531            [::]:0                 LISTENING       2000000000",
    "  TCP    127.0.0.1:19160        0.0.0.0:0              LISTENING       2000000012",
    "  TCP    0.0.0.0:91600          0.0.0.0:0              LISTENING       2000000016",
    "  TCP    [2001:db8::9160]:443   [::]:0                 LISTENING       2000000020",
    "  TCP    127.0.0.1:65531        127.0.0.1:55000        ESTABLISHED     2000000000",
    "  TCP    127.0.0.1:55000        127.0.0.1:65531        ESTABLISHED     2000000024",
    "  UDP    0.0.0.0:65531          *:*                                    2000000028",
    "",
])


@dataclass
class Done:
    stdout: str = ""
    returncode: int = 0


class FakeRun:
    """Stands in for subprocess.run: netstat answers NETSTAT, tasklist answers from `images`, taskkill is recorded."""

    def __init__(self, netstat: str, images: dict[str, str]):
        self.netstat = netstat
        self.images = images
        self.calls: list[list[str]] = []

    def __call__(self, args, **_kw):
        self.calls.append(list(args))
        if args[0] == "netstat":
            return Done(self.netstat)
        if args[0] == "tasklist":
            pid = args[2].split()[-1]
            image = self.images.get(pid)
            if image is None:
                return Done("INFO: No tasks are running which match the specified criteria.\r\n")
            return Done(f'"{image}","{pid}","Console","1","10,240 K"\r\n')
        if args[0] == "taskkill":
            return Done("SUCCESS")
        raise AssertionError(f"unexpected command {args}")

    def killed(self) -> list[str]:
        return [c[2] for c in self.calls if c[0] == "taskkill"]

    def read_the_listing(self) -> None:
        """The listing the code read was this one: a case fails when the real netstat would have been read instead."""
        assert self.calls and self.calls[0] == ["netstat", "-ano"], f"the injected netstat was not read first: {self.calls}"


class TestListeningPids:
    def test_exact_port_once_per_pid(self):
        assert listening_pids(NETSTAT, PORT) == [PID]
        assert listening_pids(NETSTAT, 19160) == ["2000000012"]
        assert listening_pids(NETSTAT, 443) == ["2000000020"]

    def test_a_longer_port_or_an_ipv6_group_is_not_the_port(self):
        # The substring match took 9160 for :19160, :91600 and [2001:db8::9160], and 6553 for :65531.
        assert listening_pids(NETSTAT, 9160) == []
        assert listening_pids(NETSTAT, 916) == []
        assert listening_pids(NETSTAT, 6553) == []
        assert listening_pids(NETSTAT, 1) == []

    def test_connections_and_udp_are_not_listeners(self):
        assert listening_pids(NETSTAT, 55000) == []
        assert listening_pids("  UDP    0.0.0.0:65531          *:*          2000000028", PORT) == []


class TestImageOfPid:
    def test_reads_the_image_from_tasklist_csv(self):
        run = FakeRun("", {PID: "bun.exe"})
        assert image_of_pid(PID, run=run) == "bun.exe"
        assert run.calls == [["tasklist", "/FI", "PID eq 2000000000", "/FO", "CSV", "/NH"]]

    def test_no_such_process_is_none(self):
        assert image_of_pid(PID, run=FakeRun("", {})) is None

    def test_a_row_for_another_pid_is_none(self):
        def run(args, **_kw):
            return Done('"bun.exe","2000000004","Console","1","10,240 K"\r\n')
        assert image_of_pid(PID, run=run) is None


class TestStopStaleEngine:
    def test_an_engine_on_the_port_is_killed_once(self):
        run = FakeRun(NETSTAT, {PID: "bun.exe"})
        said = stop_stale_engine(PORT, run=run)
        run.read_the_listing()
        assert run.killed() == [PID]
        assert ["taskkill", "/PID", PID, "/F"] in run.calls
        assert said == [("Killed stale engine (PID 2000000000)", "warning")]

    def test_anything_else_on_the_port_is_named_and_left(self):
        run = FakeRun(NETSTAT, {PID: "python.exe"})
        said = stop_stale_engine(PORT, run=run)
        run.read_the_listing()
        assert run.killed() == []
        assert said == [("Port 65531 is held by PID 2000000000 (python.exe), which is not an engine (bun.exe): left running", "warning")]

    def test_a_pid_whose_image_cannot_be_read_is_left(self):
        run = FakeRun(NETSTAT, {})
        said = stop_stale_engine(PORT, run=run)
        run.read_the_listing()
        assert run.killed() == []
        assert said == [("Port 65531 is held by PID 2000000000 (its image could not be read), which is not an engine (bun.exe): left running", "warning")]

    def test_listeners_on_other_ports_are_not_asked_about(self):
        run = FakeRun(NETSTAT, {"2000000012": "bun.exe", "2000000016": "bun.exe", "2000000020": "bun.exe"})
        # 916, a port nothing serves, never the live bridge port 9160 (check X-1): were `run` skipped, the real
        # netstat would be read here. The substring match took :91600 and [2001:db8::9160] for :916 (both bun.exe).
        assert stop_stale_engine(916, run=run) == []
        run.read_the_listing()
        assert [c[0] for c in run.calls] == ["netstat"]
