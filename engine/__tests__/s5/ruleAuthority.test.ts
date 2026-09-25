import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { RuleAuthority, isEnforced, ruleVerdictsPath } from '../../s5/ruleAuthority.js'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import type { S5Decision, S5Interface } from '../../s5/types.js'
import type { GovernanceReport } from '../../vsm/types.js'
// @ts-ignore — untyped harness module
import { RULE_VERDICTS_PATH, writeRuleVerdicts } from '../../../scripts/cynco-rule-verdicts.mjs'

afterEach(() => { vi.restoreAllMocks() })

const home = () => mkdtempSync(join(tmpdir(), 'rule-authority-'))
const fixture = (rules: Record<string, string>) => {
  const path = ruleVerdictsPath(home())
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ schema: 1, version: 3, rules: Object.fromEntries(Object.entries(rules).map(([id, verdict]) => [id, { verdict }])), predictive: Object.keys(rules).filter(k => rules[k] === 'PREDICTIVE'), history: [] }))
  return path
}

describe('RuleAuthority', () => {
  it('reads the file the campaign runner writes, at the same path', () => {
    const h = home()
    expect(ruleVerdictsPath(h)).toBe(RULE_VERDICTS_PATH(h))
    const sweep = { kind: 'withheld', killed: 1, total: 1, survived: [] }
    const rows = [
      ...Array.from({ length: 12 }, () => ({ outcome: 'failed', verified: false, mutationSweep: sweep, s5Decisions: [{ ruleIds: ['C7', 'W1'] }] })),
      ...Array.from({ length: 12 }, () => ({ outcome: 'landed', verified: true, mutationSweep: sweep, s5Decisions: [{ ruleIds: ['W1'] }] })),
    ]
    writeRuleVerdicts({ rows, campaign: 'c8', outPath: RULE_VERDICTS_PATH(h) })
    const a = RuleAuthority.load(ruleVerdictsPath(h))
    expect(a.mode).toBe('earned')
    expect(a.authorityOf(['C7'])).toBe('earned')
    expect(a.authorityOf(['W1'])).toBe('advisory')
  })

  it('no verdict file → legacy for everything, and the log line says where it looked', () => {
    const path = join(home(), 'datasets', 'rule-verdicts.json')
    const a = RuleAuthority.load(path)
    expect(a.mode).toBe('legacy')
    expect(a.authorityOf(['C7'])).toBe('legacy')
    expect(a.authorityOf([])).toBe('legacy')
    expect(a.predictiveCount()).toBe(0)
    expect(a.total()).toBe(0)
    expect(a.logLine()).toBe(`[s5] rule authority: legacy (no verdict file at ${path})`)
  })

  it('RuleAuthority.legacy() is the same legacy reading without touching disk', () => {
    const a = RuleAuthority.legacy()
    expect(a.mode).toBe('legacy')
    expect(a.authorityOf(['C1'])).toBe('legacy')
  })

  it('earned mode: earned only when EVERY rule behind the decision is PREDICTIVE', () => {
    const a = RuleAuthority.load(fixture({ C7: 'PREDICTIVE', C1: 'PREDICTIVE', W1: 'NO EVIDENCE', W2: 'TOO FEW — cannot tell' }))
    expect(a.mode).toBe('earned')
    expect(a.authorityOf(['C7'])).toBe('earned')
    expect(a.authorityOf(['C7', 'C1'])).toBe('earned')
    expect(a.authorityOf(['C7', 'W1'])).toBe('advisory')
    expect(a.authorityOf(['W2'])).toBe('advisory')
    // A rule the ledger has never seen fire has earned nothing.
    expect(a.authorityOf(['I9'])).toBe('advisory')
    // No rule behind the decision → nothing earned it.
    expect(a.authorityOf([])).toBe('advisory')
    expect(a.predictiveCount()).toBe(2)
    expect(a.total()).toBe(4)
    expect(a.logLine()).toBe('[s5] rule authority: earned (2 predictive of 4)')
  })

  it('a corrupt file is legacy WITH a warning, never a crash', () => {
    const path = ruleVerdictsPath(home())
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = RuleAuthority.load(path)
    expect(a.mode).toBe('legacy')
    expect(a.authorityOf(['C7'])).toBe('legacy')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(a.logLine()).toBe(`[s5] rule authority: legacy (unreadable verdict file at ${path})`)
  })

  it('a file of the wrong schema is legacy with a warning', () => {
    const path = ruleVerdictsPath(home())
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ schema: 2, rules: {} }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(RuleAuthority.load(path).mode).toBe('legacy')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('isEnforced', () => {
  it('advisory is never enforced; earned and legacy follow LOCALCODE_S5_ENFORCE', () => {
    expect(isEnforced(true, 'earned')).toBe(true)
    expect(isEnforced(true, 'legacy')).toBe(true)
    expect(isEnforced(true, 'advisory')).toBe(false)
    expect(isEnforced(false, 'earned')).toBe(false)
    expect(isEnforced(false, 'legacy')).toBe(false)
    expect(isEnforced(false, 'advisory')).toBe(false)
  })
})

describe('S5Orchestrator attaches the per-rule authority to every decision', () => {
  const governance = { status: 'healthy', s3s4Balance: 'balanced', modelLatencyTrend: 'stable', stuckTurns: 0, toolSuccessRate: 1 } as unknown as GovernanceReport
  const input = { userMessage: 'hi', activeWorkflow: null, currentPhase: null, contextUsagePercent: 0.1, governance, recentToolResults: [], availableModels: ['m'], turnCount: 1 }
  const fixed = (ruleIds: string[]): S5Interface => ({
    name: 'fixed',
    decide: async (): Promise<S5Decision> => ({ workflow: null, advancePhase: null, model: 'other', tools: ['Read'], contextAction: 'compact', spawnAgent: null, priority: 'balanced', reasoning: 'r', ruleIds }),
  })

  it('legacy by default — an orchestrator nobody handed a verdict file keeps today\'s behaviour', async () => {
    const d = await new S5Orchestrator(fixed(['C7'])).makeDecision(input)
    expect(d.authority).toBe('legacy')
  })

  it('advisory when a rule behind the decision has not earned it, earned when all have', async () => {
    const orch = new S5Orchestrator(fixed(['C7', 'W1']))
    orch.setRuleAuthority(RuleAuthority.load(fixture({ C7: 'PREDICTIVE', W1: 'NO EVIDENCE' })))
    const d = await orch.makeDecision(input)
    expect(d.authority).toBe('advisory')
    expect(isEnforced(true, d.authority!)).toBe(false)

    orch.setS5(fixed(['C7']))
    expect((await orch.makeDecision(input)).authority).toBe('earned')
  })
})
