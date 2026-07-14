"""Windows Job Object ownership for the engine process tree (P1 item 9).

On Windows, child processes survive parent death: if the TUI crashes or is
killed, the spawned cmd.exe -> bun -> llama-server tree lives on as zombies
(standing hazard; docs/STATE-AND-VISION-2026-07-12.md Phase 1 item 9).

Fix: the TUI creates a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
spawns the engine CREATE_SUSPENDED, assigns it to the job BEFORE it can spawn
children (descendants inherit job membership), then resumes it. When the TUI
process dies -- normally OR by crash -- the OS closes its handles, the job
closes, and the kernel kills every process in the job. No cleanup code has to
run for this to work; that is the point.

ctypes-only, zero new dependencies. The STATE doc's item 9 prescribed pywin32,
but subprocess.Popen does not expose the primary-thread handle that
win32process.ResumeThread would need, and switching to
win32process.CreateProcess would force reimplementing Popen's stdout/stderr
log-file redirection (the 4KB-pipe-deadlock fix). ctypes on kernel32 keeps
the existing Popen spawn intact; the suspended primary thread is found and
resumed via a Toolhelp32 thread snapshot instead.

All functions are no-ops returning None/False/0 on non-Windows platforms.
"""
from __future__ import annotations

import ctypes
import sys

# WinBase.h. subprocess exposes CREATE_NO_WINDOW but not CREATE_SUSPENDED.
CREATE_SUSPENDED = 0x00000004

_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9
_TH32CS_SNAPTHREAD = 0x00000004
_THREAD_SUSPEND_RESUME = 0x0002
_INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


class _THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_uint32),
        ("cntUsage", ctypes.c_uint32),
        ("th32ThreadID", ctypes.c_uint32),
        ("th32OwnerProcessID", ctypes.c_uint32),
        ("tpBasePri", ctypes.c_int32),
        ("tpDeltaPri", ctypes.c_int32),
        ("dwFlags", ctypes.c_uint32),
    ]


if sys.platform == "win32":
    # Handle-returning/consuming kernel32 functions default to c_int restype,
    # which TRUNCATES 64-bit handles -- declare everything explicitly.
    _k32 = ctypes.windll.kernel32
    _k32.CreateJobObjectW.restype = ctypes.c_void_p
    _k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    _k32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32,
    ]
    _k32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _k32.CloseHandle.argtypes = [ctypes.c_void_p]
    _k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    _k32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    _k32.Thread32First.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _k32.Thread32Next.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    _k32.OpenThread.restype = ctypes.c_void_p
    _k32.OpenThread.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    _k32.ResumeThread.restype = ctypes.c_uint32  # DWORD; (DWORD)-1 on failure
    _k32.ResumeThread.argtypes = [ctypes.c_void_p]


def create_kill_on_close_job() -> int | None:
    """Create a Job Object that kills all member processes when its last
    handle closes. Returns the raw handle (keep it alive for the TUI's
    lifetime), or None on non-Windows / API failure (callers degrade to the
    plain unsuspended spawn)."""
    if sys.platform != "win32":
        return None
    job = _k32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    ok = _k32.SetInformationJobObject(
        job, _JobObjectExtendedLimitInformation,
        ctypes.byref(info), ctypes.sizeof(info),
    )
    if not ok:
        _k32.CloseHandle(job)
        return None
    return job


def assign_process_to_job(job: int | None, process_handle: int) -> bool:
    """Assign a (still suspended) process to the job. Descendants spawned
    AFTER this inherit membership -- which is why the process must not have
    run yet."""
    if sys.platform != "win32" or not job:
        return False
    return bool(_k32.AssignProcessToJobObject(job, process_handle))


def resume_process(pid: int) -> int:
    """Resume every suspended thread of ``pid`` (a CREATE_SUSPENDED process
    has exactly one). Returns the number of threads resumed."""
    if sys.platform != "win32":
        return 0
    snap = _k32.CreateToolhelp32Snapshot(_TH32CS_SNAPTHREAD, 0)
    if not snap or snap == _INVALID_HANDLE_VALUE:
        return 0
    resumed = 0
    try:
        entry = _THREADENTRY32()
        entry.dwSize = ctypes.sizeof(_THREADENTRY32)
        has = _k32.Thread32First(snap, ctypes.byref(entry))
        while has:
            if entry.th32OwnerProcessID == pid:
                th = _k32.OpenThread(_THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if th:
                    if _k32.ResumeThread(th) != 0xFFFFFFFF:
                        resumed += 1
                    _k32.CloseHandle(th)
            has = _k32.Thread32Next(snap, ctypes.byref(entry))
    finally:
        _k32.CloseHandle(snap)
    return resumed


def close_job(job: int | None) -> None:
    """Close the job handle. With KILL_ON_JOB_CLOSE this kills every process
    still in the job -- graceful exits use it as the final sweep; crashes get
    the same effect for free when the OS reaps the dead TUI's handles."""
    if sys.platform != "win32" or not job:
        return
    _k32.CloseHandle(job)
