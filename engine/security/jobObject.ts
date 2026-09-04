/**
 * Assign THIS process to a Windows Job Object with KILL_ON_JOB_CLOSE.
 *
 * Every process we spawn afterwards (llama-server, the jlens sidecar, task
 * runner children) inherits the job, and when the last handle to the job
 * closes — i.e. when this process ends, cleanly or not — the kernel kills them
 * all. This is the structural fix for F131 and the "never reuse stale
 * processes" rule: no kill sweep, no port scan, no orphan holding 20 GB of
 * VRAM after a taskkill. Ported from Quartermaster's treecleanup_windows.go.
 *
 * BREAKAWAY_OK is set so a descendant that explicitly asks to leave the job
 * (CREATE_BREAKAWAY_FROM_JOB) can; nothing in this codebase asks today, and a
 * normal spawn stays inside.
 *
 * Off Windows this is a documented no-op: process groups handle orphans there
 * and the engine's callers already use them. Off the Bun runtime (vitest runs
 * on Node) it is also a no-op, because the kernel32 calls go through bun:ffi.
 */
export const JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
export const JOB_LIMIT_BREAKAWAY_OK = 0x0800
/** JobObjectExtendedLimitInformation */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9
/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. */
const EXTENDED_LIMIT_INFO_BYTES = 144
/** Offset of BasicLimitInformation.LimitFlags inside that struct on x64. */
const LIMIT_FLAGS_OFFSET = 16

export type JobObjectResult = { installed: boolean; reason: string }

let installed: JobObjectResult | null = null

export async function installKillOnCloseJob(): Promise<JobObjectResult> {
  if (installed) return installed
  if (process.platform !== 'win32') {
    installed = { installed: false, reason: `not win32 (${process.platform}); process groups handle orphans here` }
    return installed
  }
  if (typeof (globalThis as any).Bun === 'undefined') {
    installed = { installed: false, reason: 'bun:ffi unavailable outside the Bun runtime' }
    return installed
  }
  try {
    // A computed specifier keeps vitest's Node-side module graph from trying to
    // resolve bun:ffi; under Bun the import resolves normally.
    const ffiModule = 'bun:ffi'
    const { dlopen, FFIType, ptr } = await import(ffiModule)
    const k = dlopen('kernel32.dll', {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      GetLastError: { args: [], returns: FFIType.u32 },
    })
    const job = k.symbols.CreateJobObjectW(null, null)
    if (!job) {
      installed = { installed: false, reason: `CreateJobObjectW failed (${k.symbols.GetLastError()})` }
      return installed
    }
    const info = new ArrayBuffer(EXTENDED_LIMIT_INFO_BYTES)
    new DataView(info).setUint32(LIMIT_FLAGS_OFFSET, JOB_LIMIT_KILL_ON_JOB_CLOSE | JOB_LIMIT_BREAKAWAY_OK, true)
    if (!k.symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(info), EXTENDED_LIMIT_INFO_BYTES)) {
      installed = { installed: false, reason: `SetInformationJobObject failed (${k.symbols.GetLastError()})` }
      return installed
    }
    if (!k.symbols.AssignProcessToJobObject(job, k.symbols.GetCurrentProcess())) {
      installed = { installed: false, reason: `AssignProcessToJobObject failed (${k.symbols.GetLastError()})` }
      return installed
    }
    // The job handle is deliberately never closed: the job dies with the process.
    installed = { installed: true, reason: 'KILL_ON_JOB_CLOSE | BREAKAWAY_OK on the engine process' }
    return installed
  } catch (e) {
    installed = { installed: false, reason: `ffi error: ${e instanceof Error ? e.message : String(e)}` }
    return installed
  }
}
