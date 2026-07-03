import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DecisionJournalWriter } from '../../training/decisionJournal.js'
import { makeJournalEntry } from '../../training/types.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gjournal-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('grounding fire -> S5 journal triple', () => {
  it('writes a replayable (input, decision, outcome) triple', () => {
    const w = new DecisionJournalWriter(dir)
    w.log(makeJournalEntry({
      sessionId: 'sess-1',
      system: 'S5',
      input: { trigger: 'grounding', toolName: 'Edit', concepts: ['happiness'], intensity: 2 },
      decision: { action: 'block' },
      outcome: { grounded: false },
    }))

    const lines = readFileSync(join(dir, 's5-decisions.jsonl'), 'utf-8').trim().split('\n')
    expect(lines.length).toBe(1)
    const rec = JSON.parse(lines[0])
    expect(rec.system).toBe('S5')
    expect(rec.input.trigger).toBe('grounding')
    expect(rec.input.concepts).toEqual(['happiness'])
    expect(rec.decision.action).toBe('block')
    expect(typeof rec.timestamp).toBe('number')
  })
})
