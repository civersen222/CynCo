import { describe, expect, it, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { JSONLStore } from '../../session/jsonlStore.js'

const sessionsDir = join(homedir(), '.cynco', 'sessions')

describe('JSONLStore.gcOldSessions', () => {
  const oldId = `gc-old-${Date.now()}`, newId = `gc-new-${Date.now()}`
  afterEach(() => {
    for (const id of [oldId, newId]) { const f = join(sessionsDir, `${id}.jsonl`); if (existsSync(f)) rmSync(f) }
  })

  it('removes files older than 30 days, keeps recent ones', () => {
    mkdirSync(sessionsDir, { recursive: true })
    const oldF = join(sessionsDir, `${oldId}.jsonl`)
    const newF = join(sessionsDir, `${newId}.jsonl`)
    writeFileSync(oldF, '{}\n'); writeFileSync(newF, '{}\n')
    const ancient = (Date.now() - 40 * 86400_000) / 1000
    utimesSync(oldF, ancient, ancient)

    const removed = JSONLStore.gcOldSessions(30)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(oldF)).toBe(false)
    expect(existsSync(newF)).toBe(true)
  })
})
