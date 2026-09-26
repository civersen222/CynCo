/**
 * Retained-configuration store — the memory an ultrastable system keeps across
 * sessions.
 *
 * Ashby's ultrastable system retains the step-function configuration that
 * restored viability for each violation pattern (`UltrastableSystem.retained()`).
 * Until this store existed that memory died with the process: every session
 * began with an empty table, so the slow loop re-searched from scratch for a
 * pattern it had already solved. One file per instance under
 * `cyncoHome()/retained/<instance>.json`, versioned: the version moves only when
 * the table actually changed, and the last HISTORY_CAP tables are kept with the
 * session that wrote them — the governance data a later analysis needs to ask
 * "did a retained configuration ever get re-used, and did it hold".
 *
 * Nothing ACTS on the retained table yet. The instances import it and export it;
 * neither applies a step value anywhere and neither changes its search strategy
 * (no `Habituated`). The store makes the memory persistent and observable first.
 *
 * Instance ids in use: `session-feedback` (vsm/feedbackControl.ts) and
 * `mission-invariants` (vsm/missionInvariants.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from '../memory/atomicWrite.js'

export interface RetainedHistoryEntry {
  version: number
  at: string
  sessionId: string | null
  retained: Record<string, unknown>
}

export interface RetainedFile {
  schema: 1
  instance: string
  version: number
  updatedAt: string
  retained: Record<string, unknown>
  history: RetainedHistoryEntry[]
}

/** What the two instances need from a store — a fake satisfies it in tests. */
export interface RetainedStoreLike {
  load(instance: string): RetainedFile | null
  save(instance: string, exportedJson: string, sessionId: string | null): { version: number; changed: boolean }
}

/** Tables kept in `history`, newest last. */
export const HISTORY_CAP = 20

const INSTANCE_ID = /^[a-z0-9][a-z0-9-]*$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** Key-sorted JSON, recursively — equal tables compare equal whatever order they were built in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function isRetainedFile(v: unknown, instance: string): v is RetainedFile {
  if (!isPlainObject(v)) return false
  return v.schema === 1 &&
    v.instance === instance &&
    typeof v.version === 'number' && Number.isInteger(v.version) && v.version >= 1 &&
    typeof v.updatedAt === 'string' &&
    isPlainObject(v.retained) &&
    Array.isArray(v.history)
}

/**
 * Seed an ultrastable system from the store. Returns the stored version, or null
 * when nothing usable is stored. A table `importRetained` rejects (it validates
 * every entry and replaces atomically) is logged and leaves the system empty —
 * a bad memory must never stop a regulator from being built.
 */
export function importRetainedFrom(
  system: { importRetained(json: string): void },
  store: RetainedStoreLike,
  instance: string,
): number | null {
  try {
    const file = store.load(instance)
    if (!file) return null
    system.importRetained(JSON.stringify(file.retained))
    return file.version
  } catch (e) {
    console.log(`[retained] ${instance}: stored table not imported (${(e as Error).message}) — starting empty`)
    return null
  }
}

export class RetainedConfigStore implements RetainedStoreLike {
  constructor(private readonly dir: string) {}

  path(instance: string): string {
    if (!INSTANCE_ID.test(instance)) throw new Error(`retained store: bad instance id ${JSON.stringify(instance)}`)
    return join(this.dir, `${instance}.json`)
  }

  /**
   * The stored table, or null when there is none. A file that does not parse or
   * does not have the schema is reported (console.warn) and treated as absent —
   * a corrupt memory must not stop the engine from starting.
   */
  load(instance: string): RetainedFile | null {
    const p = this.path(instance)
    if (!existsSync(p)) return null
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'))
      if (!isRetainedFile(parsed, instance)) {
        console.warn(`[retained] ${p} is not a schema-1 retained file for ${instance} — ignored, starting fresh`)
        return null
      }
      return parsed
    } catch (e) {
      console.warn(`[retained] ${p} is unreadable (${(e as Error).message}) — ignored, starting fresh`)
      return null
    }
  }

  /**
   * Record `exportedJson` (an `UltrastableSystem.exportRetained()` string) as the
   * instance's current table. The version moves, and a history entry is added,
   * only when the parsed table differs from the stored one; an unchanged table
   * writes nothing. `version` 0 means nothing has ever been stored (an empty
   * table against no file is not a change). A corrupt file on disk is moved
   * aside to `<file>.corrupt-<ms>` rather than overwritten — it is evidence.
   *
   * @throws if `exportedJson` is not a JSON object (the caller logs it).
   */
  save(instance: string, exportedJson: string, sessionId: string | null): { version: number; changed: boolean } {
    const table: unknown = JSON.parse(exportedJson)
    if (!isPlainObject(table)) throw new Error('retained store: exported table must be a JSON object')
    const p = this.path(instance)
    const prev = this.load(instance)
    if (!prev && existsSync(p)) {
      const aside = `${p}.corrupt-${Date.now()}`
      renameSync(p, aside)
      console.warn(`[retained] moved the unreadable ${p} aside to ${aside}`)
    }
    const prevTable = prev?.retained ?? {}
    const prevVersion = prev?.version ?? 0
    if (canonical(prevTable) === canonical(table)) return { version: prevVersion, changed: false }

    const at = new Date().toISOString()
    const version = prevVersion + 1
    const history = [...(prev?.history ?? []), { version, at, sessionId, retained: table }].slice(-HISTORY_CAP)
    const file: RetainedFile = { schema: 1, instance, version, updatedAt: at, retained: table, history }
    mkdirSync(this.dir, { recursive: true })
    writeFileAtomic(p, JSON.stringify(file, null, 2) + '\n')
    return { version, changed: true }
  }
}
