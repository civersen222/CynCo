import { describe, it, expect, afterAll, vi } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RetainedConfigStore, HISTORY_CAP } from '../../vsm/retainedConfigStore.js'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cynco-retained-'))
  dirs.push(d)
  return d
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 }) })

const T1 = JSON.stringify({ 'callsSinceSourceEdit': { Discrete: 'edit-only' } })
const T2 = JSON.stringify({ 'callsSinceCommit': { Discrete: 'edit-only' }, 'callsSinceSourceEdit': { Discrete: 'edit-only' } })

describe('RetainedConfigStore', () => {
  it('load is null when nothing was ever stored', () => {
    expect(new RetainedConfigStore(tempDir()).load('session-feedback')).toBeNull()
  })

  it('round-trips a table through save and load, with the schema fields', () => {
    const dir = tempDir()
    const store = new RetainedConfigStore(dir)
    expect(store.save('mission-invariants', T1, 'session-1')).toEqual({ version: 1, changed: true })
    const f = store.load('mission-invariants')!
    expect(f.schema).toBe(1)
    expect(f.instance).toBe('mission-invariants')
    expect(f.version).toBe(1)
    expect(f.retained).toEqual(JSON.parse(T1))
    expect(f.history).toEqual([{ version: 1, at: f.updatedAt, sessionId: 'session-1', retained: JSON.parse(T1) }])
    expect(store.path('mission-invariants')).toBe(join(dir, 'mission-invariants.json'))
    // A fresh store over the same directory reads the same file (cross-session).
    expect(new RetainedConfigStore(dir).load('mission-invariants')!.retained).toEqual(JSON.parse(T1))
  })

  it('moves the version only when the parsed table differs', () => {
    const store = new RetainedConfigStore(tempDir())
    // An empty table against no file is not a change — nothing is written.
    expect(store.save('session-feedback', '{}', null)).toEqual({ version: 0, changed: false })
    expect(existsSync(store.path('session-feedback'))).toBe(false)
    expect(store.save('session-feedback', T1, 's1')).toEqual({ version: 1, changed: true })
    expect(store.save('session-feedback', T1, 's2')).toEqual({ version: 1, changed: false })
    // Same table, keys in a different order — still unchanged.
    const reordered = JSON.stringify({ 'callsSinceSourceEdit': { Discrete: 'edit-only' }, 'callsSinceCommit': { Discrete: 'edit-only' } })
    expect(store.save('session-feedback', T2, 's3')).toEqual({ version: 2, changed: true })
    expect(store.save('session-feedback', reordered, 's4')).toEqual({ version: 2, changed: false })
    const f = store.load('session-feedback')!
    expect(f.history.map(h => h.sessionId)).toEqual(['s1', 's3'])
  })

  it('caps history at 20 tables, newest last', () => {
    const store = new RetainedConfigStore(tempDir())
    for (let i = 1; i <= HISTORY_CAP + 5; i++) {
      store.save('session-feedback', JSON.stringify({ k: { Continuous: [i] } }), `s${i}`)
    }
    const f = store.load('session-feedback')!
    expect(HISTORY_CAP).toBe(20)
    expect(f.version).toBe(25)
    expect(f.history).toHaveLength(20)
    expect(f.history[0].version).toBe(6)
    expect(f.history.at(-1)!.version).toBe(25)
    expect(f.history.at(-1)!.retained).toEqual({ k: { Continuous: [25] } })
  })

  it('a corrupt file loads as null with a warning, and save moves it aside instead of overwriting it', () => {
    const dir = tempDir()
    const store = new RetainedConfigStore(dir)
    writeFileSync(store.path('mission-invariants'), '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(store.load('mission-invariants')).toBeNull()
      expect(warn).toHaveBeenCalled()
      expect(store.save('mission-invariants', T1, null)).toEqual({ version: 1, changed: true })
    } finally {
      warn.mockRestore()
    }
    const aside = readdirSync(dir).filter(n => n.startsWith('mission-invariants.json.corrupt-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(join(dir, aside[0]), 'utf-8')).toBe('{ not json')
    expect(store.load('mission-invariants')!.retained).toEqual(JSON.parse(T1))
  })

  it('a well-formed file with the wrong schema or instance is treated as corrupt', () => {
    const store = new RetainedConfigStore(tempDir())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeFileSync(store.path('session-feedback'), JSON.stringify({ schema: 2, instance: 'session-feedback', version: 1, updatedAt: 'x', retained: {}, history: [] }))
      expect(store.load('session-feedback')).toBeNull()
      writeFileSync(store.path('session-feedback'), JSON.stringify({ schema: 1, instance: 'mission-invariants', version: 1, updatedAt: 'x', retained: {}, history: [] }))
      expect(store.load('session-feedback')).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects a non-object export and an instance id that could escape the directory', () => {
    const store = new RetainedConfigStore(tempDir())
    expect(() => store.save('session-feedback', '[1,2]', null)).toThrow()
    expect(() => store.path('../evil')).toThrow()
  })

  it('writes with tmp+rename — no temp sibling survives a save', () => {
    const dir = tempDir()
    const store = new RetainedConfigStore(dir)
    store.save('session-feedback', T1, null)
    expect(readdirSync(dir)).toEqual(['session-feedback.json'])
  })
})
