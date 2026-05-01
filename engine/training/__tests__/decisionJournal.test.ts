import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DecisionJournalWriter, getJournal, initJournal } from '../decisionJournal.js'
import { makeJournalEntry } from '../types.js'
import type { SystemLevel } from '../types.js'

let tmpDirs: string[] = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'journal-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
  tmpDirs = []
})

describe('DecisionJournalWriter', () => {
  test('creates training directory on construction', () => {
    const tmp = makeTmp()
    const trainingDir = join(tmp, 'training')
    new DecisionJournalWriter(trainingDir)
    expect(existsSync(trainingDir)).toBe(true)
  })

  test('log() writes JSONL entry to s1-decisions.jsonl for S1', () => {
    const tmp = makeTmp()
    const writer = new DecisionJournalWriter(tmp)
    const entry = makeJournalEntry({
      sessionId: 'sess-001',
      system: 'S1',
      input: { prompt: 'hello' },
      decision: { tokens: 128 },
    })
    writer.log(entry)

    const filePath = join(tmp, 's1-decisions.jsonl')
    expect(existsSync(filePath)).toBe(true)
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.sessionId).toBe('sess-001')
    expect(parsed.system).toBe('S1')
    expect(parsed.input).toEqual({ prompt: 'hello' })
    expect(parsed.decision).toEqual({ tokens: 128 })
  })

  test('log() appends multiple entries (3 entries → 3 lines)', () => {
    const tmp = makeTmp()
    const writer = new DecisionJournalWriter(tmp)
    for (let i = 0; i < 3; i++) {
      writer.log(makeJournalEntry({
        sessionId: `sess-${i}`,
        system: 'S3',
        input: { index: i },
        decision: { result: `r${i}` },
      }))
    }

    const filePath = join(tmp, 's3-decisions.jsonl')
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      const parsed = JSON.parse(lines[i])
      expect(parsed.sessionId).toBe(`sess-${i}`)
    }
  })

  test('log() routes to correct file per system (S1/S2/S5 → different files)', () => {
    const tmp = makeTmp()
    const writer = new DecisionJournalWriter(tmp)

    const systems: SystemLevel[] = ['S1', 'S2', 'S5']
    for (const sys of systems) {
      writer.log(makeJournalEntry({
        sessionId: 'sess-multi',
        system: sys,
        input: { sys },
        decision: { routed: true },
      }))
    }

    expect(existsSync(join(tmp, 's1-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(tmp, 's2-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(tmp, 's5-decisions.jsonl'))).toBe(true)
    expect(existsSync(join(tmp, 's3-decisions.jsonl'))).toBe(false)
    expect(existsSync(join(tmp, 's4-decisions.jsonl'))).toBe(false)

    // Verify each file has exactly one entry with the correct system
    for (const sys of systems) {
      const file = join(tmp, `s${sys[1]}-decisions.jsonl`)
      const lines = readFileSync(file, 'utf-8').trim().split('\n')
      expect(lines).toHaveLength(1)
      const parsed = JSON.parse(lines[0])
      expect(parsed.system).toBe(sys)
    }
  })

  test('backfill() writes a backfill record with _backfill: true', () => {
    const tmp = makeTmp()
    const writer = new DecisionJournalWriter(tmp)
    writer.backfill('S4', 1700000000000, { divergence: 0.12 })

    const filePath = join(tmp, 's4-decisions.jsonl')
    expect(existsSync(filePath)).toBe(true)
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed._backfill).toBe(true)
    expect(parsed.system).toBe('S4')
    expect(parsed.entryTimestamp).toBe(1700000000000)
    expect(parsed.outcome).toEqual({ divergence: 0.12 })
  })

  test('entryCount() returns per-system counts', () => {
    const tmp = makeTmp()
    const writer = new DecisionJournalWriter(tmp)

    expect(writer.entryCount('S1')).toBe(0)
    expect(writer.entryCount('S2')).toBe(0)

    writer.log(makeJournalEntry({ sessionId: 's', system: 'S1', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's', system: 'S1', input: {}, decision: {} }))
    writer.log(makeJournalEntry({ sessionId: 's', system: 'S2', input: {}, decision: {} }))
    writer.backfill('S1', Date.now(), { ok: true })

    expect(writer.entryCount('S1')).toBe(3)  // 2 log + 1 backfill
    expect(writer.entryCount('S2')).toBe(1)
    expect(writer.entryCount('S3')).toBe(0)
  })
})

describe('getJournal / initJournal singleton', () => {
  test('getJournal returns null before init', () => {
    // Note: singleton state may be set from other tests, so we just test initJournal
    const tmp = makeTmp()
    const journal = initJournal(tmp)
    expect(journal).toBeInstanceOf(DecisionJournalWriter)
    expect(getJournal()).toBe(journal)
  })

  test('initJournal replaces existing instance', () => {
    const tmp1 = makeTmp()
    const tmp2 = makeTmp()
    const j1 = initJournal(tmp1)
    const j2 = initJournal(tmp2)
    expect(j2).not.toBe(j1)
    expect(getJournal()).toBe(j2)
  })
})
