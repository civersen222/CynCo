/**
 * engine/power/reporter/idle.ts — how long since the owner last touched keyboard or mouse.
 *
 * Windows keeps the tick of the last input for the interactive session
 * (`GetLastInputInfo`); the reporter's task runs in that session, so the
 * answer is the owner's. Read through `bun:ffi`, with no process started.
 * Off Windows, or outside Bun (the suite runs on Node), the answer is null:
 * unknown, never 0.
 */

/** Milliseconds between two 32-bit tick counts; the counter wraps every 49.7 days. */
export function ticksBetween(now: number, last: number): number {
  return (now - last) >>> 0
}

type Reader = () => number | null
let reader: Reader | null | undefined

async function openReader(): Promise<Reader | null> {
  const bun = (globalThis as { Bun?: { version?: unknown } }).Bun
  if (process.platform !== 'win32' || typeof bun?.version !== 'string') return null
  // Computed specifier: vitest's Node-side graph must not try to resolve bun:ffi.
  const ffiModule = 'bun:ffi'
  const { dlopen, FFIType, ptr } = await import(ffiModule)
  const user32 = dlopen('user32.dll', { GetLastInputInfo: { args: [FFIType.ptr], returns: FFIType.i32 } })
  const kernel32 = dlopen('kernel32.dll', { GetTickCount: { args: [], returns: FFIType.u32 } })
  // LASTINPUTINFO: UINT cbSize, DWORD dwTime = 8 bytes.
  const buf = new ArrayBuffer(8)
  const view = new DataView(buf)
  return () => {
    view.setUint32(0, 8, true)
    if (!user32.symbols.GetLastInputInfo(ptr(buf))) return null
    return ticksBetween(Number(kernel32.symbols.GetTickCount()), view.getUint32(4, true)) / 1000
  }
}

/** Seconds since the last keyboard or mouse input in this session, or null when that cannot be read. */
export async function readIdleSeconds(): Promise<number | null> {
  if (reader === undefined) {
    try {
      reader = await openReader()
    } catch (err) {
      console.log(`[watch] the owner's idle time cannot be read: ${err instanceof Error ? err.message : String(err)}`)
      reader = null
    }
  }
  return reader ? reader() : null
}
