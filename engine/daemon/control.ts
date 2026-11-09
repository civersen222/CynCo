// engine/daemon/control.ts
// The daemon's one control surface besides ntfy: a small JSON file the desk widget
// (scripts/cynco-widget.ps1) writes. `{"paused": true}` asks the daemon to free the GPU —
// kill the running pass, remember where it was, fire nothing — and `{"paused": false}` (or
// deleting the file) lets it resume the interrupted pass from its journal and go back to
// its schedule. Read on every tick and every few seconds inside a running task; a torn or
// malformed file never pauses anything.
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

export const CONTROL_FILE_NAME = 'daemon-control.json'

export type DaemonControl = {
  paused: boolean
  /** ISO timestamp the widget wrote with the request, when present. */
  requestedAt?: string
}

export function defaultControlPath(cyncoHome: string): string {
  return join(cyncoHome, CONTROL_FILE_NAME)
}

export function readControl(path: string): DaemonControl {
  if (!existsSync(path)) return { paused: false }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { paused?: unknown; requestedAt?: unknown }
    return {
      paused: raw?.paused === true,
      ...(typeof raw?.requestedAt === 'string' ? { requestedAt: raw.requestedAt } : {}),
    }
  } catch {
    return { paused: false }
  }
}
