import { describe, test, expect } from 'bun:test'
import { makeJournalEntry, makeBackfillRecord } from '../types.js'

describe('training/types', () => {
  test('makeJournalEntry creates valid entry with required fields, timestamp > 0, no agentId/outcome when not provided', () => {
    const entry = makeJournalEntry({
      sessionId: 'sess-001',
      system: 'S3',
      input: { task: 'classify' },
      decision: { action: 'route-to-S1' },
    })

    expect(entry.sessionId).toBe('sess-001')
    expect(entry.system).toBe('S3')
    expect(entry.input).toEqual({ task: 'classify' })
    expect(entry.decision).toEqual({ action: 'route-to-S1' })
    expect(typeof entry.timestamp).toBe('number')
    expect(entry.timestamp).toBeGreaterThan(0)
    expect('agentId' in entry).toBe(false)
    expect('outcome' in entry).toBe(false)
  })

  test('makeJournalEntry accepts optional agentId and outcome', () => {
    const entry = makeJournalEntry({
      sessionId: 'sess-002',
      system: 'S1',
      input: { prompt: 'hello' },
      decision: { tokens: 128 },
      agentId: 'agent-42',
      outcome: { status: 'ok', latencyMs: 350 },
    })

    expect(entry.agentId).toBe('agent-42')
    expect(entry.outcome).toEqual({ status: 'ok', latencyMs: 350 })
  })

  test('makeBackfillRecord creates valid record with _backfill: true', () => {
    const record = makeBackfillRecord({
      system: 'S4',
      entryTimestamp: 1700000000000,
      outcome: { divergence: 0.12 },
    })

    expect(record._backfill).toBe(true)
    expect(record.system).toBe('S4')
    expect(record.entryTimestamp).toBe(1700000000000)
    expect(record.outcome).toEqual({ divergence: 0.12 })
  })
})
