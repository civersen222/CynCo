import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { formatJournalInput, joinViableExamples, exportViableExamples, exportSummaryLines } from '../../s5/exportTrainingData.js'
import type { JournalEntry } from '../../training/types.js'

function entry(sessionId: string): JournalEntry {
  return {
    timestamp: 1, sessionId, system: 'S5',
    input: { userMessage: 'fix the bug', activeWorkflow: null, contextUsagePercent: 0.5,
             turnCount: 4, recentToolResults: [{ tool: 'Read', success: true }],
             governanceStatus: 'healthy', varietyBalance: 'balanced', promptDifficulty: 'medium' },
    decision: { workflow: null, contextAction: 'none', priority: 'balanced', reasoning: 'ok' },
  }
}

describe('exportTrainingData', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'export-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir */ } })

  it('formatJournalInput renders a stable, non-empty prompt string', () => {
    const s = formatJournalInput(entry('s1').input)
    expect(s).toContain('User: fix the bug')
    expect(s).toContain('Context: 50%')
    expect(s.length).toBeGreaterThan(0)
  })

  it('joinViableExamples keeps only viable-session decisions and preserves the real decision as output', () => {
    const entries = [entry('viable-1'), entry('nonviable-1'), entry('missing-1')]
    const outcomes = new Map([['viable-1', 'viable'], ['nonviable-1', 'non-viable']])
    const examples = joinViableExamples(entries, outcomes)
    expect(examples).toHaveLength(1)
    expect(JSON.parse(examples[0].output).reasoning).toBe('ok')
  })

  it('exportViableExamples writes JSONL for viable sessions', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [entry('v'), entry('nv')].map(e => JSON.stringify(e)).join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
    expect(existsSync(out)).toBe(true)
    const line = JSON.parse(readFileSync(out, 'utf-8').trim())
    expect(line).toHaveProperty('input')
    expect(line).toHaveProperty('output')
  })

  it('exportViableExamples writes nothing and reports 0 when no viable sessions match', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, JSON.stringify(entry('nv')) + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['nv', 'non-viable']]) })
    expect(res.written).toBe(0)
    expect(existsSync(out)).toBe(false)
  })

  it('folds a decisionId-keyed backfill onto its entry and drops the measured negative', () => {
    const good = entry('v'); (good.decision as any).decisionId = 'd-good'
    const bad = entry('v'); (bad.decision as any).decisionId = 'd-bad'
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(good),
      JSON.stringify(bad),
      JSON.stringify({ _backfill: true, system: 'S5', decisionId: 'd-bad', outcome: { outcome: 'negative', measured: true } }),
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    // Both decisions are in the same viable session, so the session label cannot
    // separate them. The per-decision label can — that is the entire point.
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })

  it('keeps an unknown-outcome decision — unmeasured is not a veto', () => {
    const e = entry('v'); (e.decision as any).decisionId = 'd1'
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(e),
      JSON.stringify({ _backfill: true, system: 'S5', decisionId: 'd1', outcome: { outcome: 'unknown', measured: false } }),
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })

  it('strips decisionId, ruleIds and rejected from the training target', () => {
    const e = entry('v')
    Object.assign(e.decision, { decisionId: 'd1', ruleIds: ['W2'], rejected: [{ ruleId: 'W9' }] })
    const examples = joinViableExamples([e], new Map([['v', 'viable']]))
    const target = JSON.parse(examples[0].output)
    // The output string is the model's training target. A UUID in it teaches the
    // model to invent UUIDs; ruleIds and rejected teach it to imitate the rule
    // engine's internals, which is what this corpus exists to move past.
    expect(target.decisionId).toBeUndefined()
    expect(target.ruleIds).toBeUndefined()
    expect(target.rejected).toBeUndefined()
    expect(target.reasoning).toBe('ok')
  })

  // Phase 4: the corpus is earned-only. A decision is training data only when
  // every rule behind it is PREDICTIVE in the verdict file the campaign runner
  // writes — imitating a rule that predicts nothing launders noise into weights.
  describe('earned-only filter', () => {
    const withRules = (ruleIds: string[] | undefined, id: string) => {
      const e = entry('v'); Object.assign(e.decision, { decisionId: id }, ruleIds ? { ruleIds } : {}); return e
    }
    const writeJournal = (entries: JournalEntry[]) => {
      const p = join(dir, 's5-decisions.jsonl')
      writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
      return p
    }
    const verdicts = (rules: Record<string, string>) => {
      const p = join(dir, 'rule-verdicts.json')
      writeFileSync(p, JSON.stringify({ schema: 1, version: 1, rules: Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, { verdict: v }])), predictive: [], history: [] }))
      return p
    }
    const outcomes = new Map([['v', 'viable']])

    it('drops every decision a non-PREDICTIVE rule (or no rule) produced, and counts why', () => {
      const journalPath = writeJournal([
        withRules(['C7'], 'keep'),
        withRules(['C7', 'W1'], 'mixed'),
        withRules(['W1'], 'w1'),
        withRules([], 'none'),
        withRules(undefined, 'missing'),
        withRules(['I9'], 'unseen'),
      ])
      const out = join(dir, 'out.jsonl')
      const res = exportViableExamples({ journalPath, outPath: out, outcomeBySession: outcomes, verdictsPath: verdicts({ C7: 'PREDICTIVE', W1: 'NO EVIDENCE' }) })
      expect(res.written).toBe(1)
      expect(res.excluded).toEqual({ byRule: { W1: 2, '(none)': 2, I9: 1 }, bySeat: {}, legacy: false })
      expect(readFileSync(out, 'utf-8').trim().split('\n')).toHaveLength(1)
    })

    it('no verdict file: legacy pass-through, and it says so', () => {
      const journalPath = writeJournal([withRules(['W1'], 'a'), withRules([], 'b')])
      const res = exportViableExamples({ journalPath, outPath: join(dir, 'out.jsonl'), outcomeBySession: outcomes, verdictsPath: join(dir, 'absent.json') })
      expect(res.written).toBe(2)
      expect(res.excluded).toEqual({ byRule: {}, bySeat: {}, legacy: true })
    })

    it('no verdictsPath at all is legacy too — the pre-Phase-4 call keeps its behaviour', () => {
      const journalPath = writeJournal([withRules(['W1'], 'a')])
      const res = exportViableExamples({ journalPath, outPath: join(dir, 'out.jsonl'), outcomeBySession: outcomes })
      expect(res.written).toBe(1)
      expect(res.excluded.legacy).toBe(true)
    })

    it('reports the seats\' retained authorities, 0 when the store is absent', () => {
      const journalPath = writeJournal([withRules(['W1'], 'a')])
      const absent = exportViableExamples({ journalPath, outPath: join(dir, 'out.jsonl'), outcomeBySession: outcomes, seatsPath: join(dir, 'no-seats.json') })
      expect(absent.seats).toEqual({ ideation: 0, 'gate-author': 0 })
      const seatsPath = join(dir, 'seats.json')
      writeFileSync(seatsPath, JSON.stringify({ schema: 1, version: 1, seats: { ideation: { authority: 0.5 } }, history: [] }))
      const present = exportViableExamples({ journalPath, outPath: join(dir, 'out.jsonl'), outcomeBySession: outcomes, seatsPath })
      expect(present.seats).toEqual({ ideation: 0.5, 'gate-author': 0 })
      // The S5 journal carries no seat rows, so nothing is excluded by seat.
      expect(present.excluded.bySeat).toEqual({})
    })

    it('exportSummaryLines prints the table the CLIs show', () => {
      expect(exportSummaryLines({ written: 3, excluded: { byRule: { W1: 2, '(none)': 5, C2: 2 }, bySeat: {}, legacy: false }, seats: { ideation: 0.5, 'gate-author': 0 } }, 'out.jsonl')).toEqual([
        '[export] wrote 3 example(s) to out.jsonl',
        '[export] rule filter: earned-only — kept decisions whose every rule is PREDICTIVE',
        '  excluded by rule   decisions',
        '  (none)                    5',
        '  C2                        2',
        '  W1                        2',
        '  excluded by seat: none (the S5 journal carries no seat rows)',
        '  seats: ideation 0.5, gate-author 0',
      ])
      expect(exportSummaryLines({ written: 1, excluded: { byRule: {}, bySeat: {}, legacy: true }, seats: { ideation: 0, 'gate-author': 0 } }, 'o')).toEqual([
        '[export] wrote 1 example(s) to o',
        '[export] rule filter: legacy — no rule-verdict file, nothing excluded by rule',
        '  excluded by seat: none (the S5 journal carries no seat rows)',
        '  seats: ideation 0, gate-author 0',
      ])
    })

    it('a missing journal still reports a full summary', () => {
      const res = exportViableExamples({ journalPath: join(dir, 'nope.jsonl'), outPath: join(dir, 'out.jsonl'), outcomeBySession: outcomes, verdictsPath: verdicts({ C7: 'PREDICTIVE' }) })
      expect(res).toEqual({ written: 0, excluded: { byRule: {}, bySeat: {}, legacy: false }, seats: { ideation: 0, 'gate-author': 0 } })
    })
  })

  it('exportViableExamples skips _backfill records and malformed lines', () => {
    const journal = join(dir, 's5-decisions.jsonl')
    writeFileSync(journal, [
      JSON.stringify(entry('v')),
      JSON.stringify({ _backfill: true, system: 'S5', entryTimestamp: 1, outcome: {} }),
      '{ this is not json',
    ].join('\n') + '\n')
    const out = join(dir, 'out.jsonl')
    const res = exportViableExamples({ journalPath: journal, outPath: out, outcomeBySession: new Map([['v', 'viable']]) })
    expect(res.written).toBe(1)
  })
})
