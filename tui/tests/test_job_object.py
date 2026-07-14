"""P1 item 9: Windows Job Object owns the engine process tree.

The grandchild test proves the whole point: a suspended-spawn -> assign ->
resume tree dies when the job handle closes, INCLUDING grandchildren the
direct child spawned after resume (llama-server is exactly such a grandchild).
"""
import ctypes
import os
import subprocess
import sys
import tempfile
import time

import pytest

from localcode_tui.job_object import (
    CREATE_SUSPENDED,
    assign_process_to_job,
    close_job,
    create_kill_on_close_job,
    resume_process,
)

win_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows Job Objects")


def _alive(pid: int) -> bool:
    """True if pid is a live process (Windows-only helper)."""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    STILL_ACTIVE = 259
    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    try:
        code = ctypes.c_uint32()
        k32.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
        return code.value == STILL_ACTIVE
    finally:
        k32.CloseHandle(ctypes.c_void_p(h))


@win_only
def test_create_job_returns_handle():
    job = create_kill_on_close_job()
    assert job
    close_job(job)


@win_only
def test_suspended_spawn_assign_resume_runs():
    """CREATE_SUSPENDED spawn is frozen until resume_process; then it runs."""
    job = create_kill_on_close_job()
    proc = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        creationflags=CREATE_SUSPENDED,
    )
    try:
        assert assign_process_to_job(job, proc._handle)
        assert resume_process(proc.pid) >= 1
        time.sleep(0.5)
        assert proc.poll() is None  # resumed and running, not stuck suspended
    finally:
        close_job(job)  # KILL_ON_JOB_CLOSE reaps it
        proc.wait(timeout=5)


@win_only
def test_close_job_kills_grandchildren():
    """The zombie-class kill: a grandchild spawned AFTER resume dies with the job."""
    pid_file = os.path.join(tempfile.mkdtemp(), "grandchild.pid")
    child_code = (
        "import subprocess, sys, time\n"
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "open(sys.argv[1], 'w').write(str(g.pid))\n"
        "time.sleep(60)\n"
    )
    job = create_kill_on_close_job()
    proc = subprocess.Popen(
        [sys.executable, "-c", child_code, pid_file],
        creationflags=CREATE_SUSPENDED,
    )
    assert assign_process_to_job(job, proc._handle)
    resume_process(proc.pid)
    gpid = None
    deadline = time.time() + 10
    while time.time() < deadline:
        if os.path.exists(pid_file):
            content = open(pid_file).read().strip()
            if content:
                gpid = int(content)
                break
        time.sleep(0.1)
    assert gpid is not None, "grandchild never reported its pid"
    assert _alive(proc.pid) and _alive(gpid)
    close_job(job)  # KILL_ON_JOB_CLOSE -> whole tree dies, no cleanup code ran
    deadline = time.time() + 5
    while time.time() < deadline and (_alive(proc.pid) or _alive(gpid)):
        time.sleep(0.1)
    assert not _alive(proc.pid)
    assert not _alive(gpid)


def test_non_windows_noops():
    """POSIX: every helper degrades to a harmless no-op."""
    if sys.platform == "win32":
        pytest.skip("POSIX no-op path")
    assert create_kill_on_close_job() is None
    assert assign_process_to_job(None, 0) is False
    assert resume_process(1234) == 0
    close_job(None)  # must not raise
