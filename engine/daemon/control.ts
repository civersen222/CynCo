// engine/daemon/control.ts
// The daemon's one control surface besides ntfy: a small JSON file the desk widget
// (scripts/cynco-widget.ps1) writes. `{"paused": true}` asks the daemon to free the GPU —
// kill the running pass, remember where it was, fire nothing — and `{"paused": false}` (or
// deleting the file) lets it resume the interrupted pass from its journal and go back to
// its schedule. Read on every tick and every few seconds inside a running task; a torn or
// malformed file never pauses anything.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

export const CONTROL_FILE_NAME = 'daemon-control.json'

export type DaemonControl = {
  paused: boolean
  /** ISO timestamp the widget wrote with the request, when present. */
  requestedAt?: string
  /** Which surface wrote the request, when it said. */
  by?: 'widget' | 'dashboard'
}

export function defaultControlPath(cyncoHome: string): string {
  return join(cyncoHome, CONTROL_FILE_NAME)
}

export function readControl(path: string): DaemonControl {
  if (!existsSync(path)) return { paused: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { paused?: unknown; requestedAt?: unknown; by?: unknown }
    return {
      paused: raw?.paused === true,
      ...(typeof raw?.requestedAt === 'string' ? { requestedAt: raw.requestedAt } : {}),
      ...(raw?.by === 'widget' || raw?.by === 'dashboard' ? { by: raw.by } : {}),
    }
  } catch {
    return { paused: false }
  }
}

/** Write the control file atomically (tmp in the same dir, then rename over it). */
export function writeControl(path: string, paused: boolean, by: 'widget' | 'dashboard'): DaemonControl {
  const control: DaemonControl = { paused, requestedAt: new Date().toISOString(), by }
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(control), 'utf-8')
  renameSync(tmp, path)
  return control
}
