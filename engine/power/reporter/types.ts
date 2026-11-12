/**
 * engine/power/reporter/types.ts — what a box tells the watcher (push protocol v1).
 *
 * The watcher (`scripts/doorman/watcher.py`, on the doorman) never asks a box
 * for anything: the box POSTs `PushBody` to `<LOCALCODE_WATCHER_URL>/push`.
 * A `Sample` is the box's state at one moment, on a beat. A `WatchEvent` is a
 * change, stamped with the time it happened (a sleep is reported after the
 * wake), and carries a `key` so a push that is repeated stores nothing twice.
 * A field the box could not read is `null`, never a made-up 0.
 * Design: docs/decisions/2026-11-11-metasystem-design.md (slice 1).
 */

export type GpuRow = {
  i: number
  name: string
  tempC: number | null
  memUsedMib: number | null
  memTotalMib: number | null
  utilPct: number | null
  /** Image names of the processes with a context on the card (Windows gives no per-process memory). */
  procs: string[]
}

/** `busy`: true = a request is in flight, false = loaded and idle, null = could not tell. */
export type ModelRow = { server: string; name: string; busy: boolean | null }

/** Who holds the GPU by CynCo's own reckoning: `oneshot:<triggerId>`, `engine`, `app:<id>`, `foreign`, `none`, `unknown`. */
export type HolderRow = { unit: string; detail: string }

export type EngineRow = {
  up: boolean
  modelState: string | null
  processing: boolean | null
  /** The engine's open activities (`engine/power/activity.ts` `snapshot()`), or null from an engine that does not report them. */
  open: Array<{ kind: string; label?: string; sinceS: number }> | null
}

/** `wanted`: something on this box depends on the service right now; `by` says what. */
export type ServiceRow = { name: string; up: boolean; wanted: boolean; by: string }

export type Sample = {
  t: 'sample'
  at: string
  /** Seconds since the owner last touched keyboard or mouse. */
  idleS: number | null
  gpus: GpuRow[] | null
  models: ModelRow[] | null
  holder: HolderRow | null
  engine: EngineRow | null
  services: ServiceRow[]
}

export type WatchEvent = { t: 'event'; at: string; kind: string; key: string; data: Record<string, unknown> }

export type WatchRecord = Sample | WatchEvent

export type PushBody = { v: 1; box: string; sentAt: string; records: WatchRecord[] }

/** An ISO time cut to the second: what event keys are made of, so the same moment read twice has one key. */
export function toSecond(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z') : iso
}
