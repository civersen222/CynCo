import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseIdeation, measureFollowed, authorityRegistry, promotionProposal, ideationPrompt, runIdeation } from '../cynco-ideation.mjs'

describe('ideation', () => {
  it('parses the daemon outcome contract into hypotheses and a trap', () => {
    const out = { ok: true, summary: 'two causes', recommendations: [
      { id: 'rec-1', actionType: 'hypothesis', summary: 'C8.5.palette.Atlas', detail: 'owner fills are five hues | firstEdit: gilded/ui/widgets.py' },
      { id: 'rec-2', actionType: 'trap', summary: 'trap', detail: 'do not add a hex to palette.py' } ] }
    expect(parseIdeation(out)).toEqual({ hypotheses: [{ gateId: 'C8.5.palette.Atlas', cause: 'owner fills are five hues', firstEdit: 'gilded/ui/widgets.py' }], order: ['C8.5.palette.Atlas'], trap: 'do not add a hex to palette.py' })
    expect(parseIdeation({ ok: true, summary: '(unstructured output) blah', recommendations: [] })).toBeNull()
  })
  it('prompt asks for the outcome contract and forbids writes', () => {
    const { prompt } = ideationPrompt({ spec: { id: 'c8', work: [] }, fails: [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }], prior: null, briefText: 'BRIEF' })
    expect(prompt).toMatch(/"actionType": "hypothesis"/)
    expect(prompt).toMatch(/C8\.1a: FAIL x/)
    expect(prompt).toMatch(/do not edit/i)
  })
  it('measures followed by the first commit\'s files', () => {
    const idea = { hypotheses: [{ gateId: 'C8.5.palette.Atlas', cause: 'x', firstEdit: 'gilded/ui/widgets.py' }], order: [], trap: null }
    expect(measureFollowed(idea, ['gilded/ui/widgets.py', 'gilded/tests/test_c8_palette.py'])).toBe(true)
    expect(measureFollowed(idea, ['gilded/ui/app.py'])).toBe(false)
    expect(measureFollowed(null, ['gilded/ui/widgets.py'])).toBeNull()
  })
  it('the deterministic generator commands the brief until ideation earns authority', () => {
    expect(authorityRegistry({ ideationAuthority: 0 }).whoCommands('brief')?.component).toBe('generator')
    expect(authorityRegistry({ ideationAuthority: 0.5 }).whoCommands('brief')?.component).toBe('generator')
  })
  it('proposes promotion only with ≥8 ideated waves and a significant association', () => {
    const w = (followed, landed) => ({ s4: { ideation: {}, followed }, outcome: { landed } })
    expect(promotionProposal([w(true, true), w(true, true)], 0)).toBeNull()
    const strong = [...Array(6)].map(() => w(true, true)).concat([...Array(6)].map(() => w(false, false)))
    const p = promotionProposal(strong, 0)
    expect(p).toMatchObject({ type: 'Parameter', name: 'ideation/brief', newValue: 0.5, bounds: { min: 0, max: 0.5 } })
    expect(p.evidence.p).toBeLessThan(0.05)
    const noise = [...Array(6)].map((_, i) => w(i % 2 === 0, i % 3 === 0)).concat([...Array(6)].map((_, i) => w(i % 3 === 0, i % 2 === 0)))
    expect(promotionProposal(noise, 0)).toBeNull()
    expect(promotionProposal(strong, 0.5)).toBeNull() // already at the bound
  })
  it('runIdeation writes a task file and parses the outcome via an injected io.runTask', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cynco-ideation-'))
    const outcome = { ok: true, summary: 'one cause', recommendations: [
      { id: 'rec-1', actionType: 'hypothesis', summary: 'C8.1a', detail: 'owner fill missing | firstEdit: gilded/ui/widgets.py' },
      { id: 'rec-2', actionType: 'trap', summary: 'trap', detail: 'do not touch palette.py' } ] }
    const io = {
      runTask: async (repoRoot, taskPath, env, cwd) => {
        const task = JSON.parse(readFileSync(taskPath, 'utf8'))
        const { writeFileSync } = await import('node:fs')
        writeFileSync(task.outcomePath, JSON.stringify(outcome))
        return 0
      },
    }
    const spec = { id: 'c8', repo: process.cwd(), work: [] }
    const fails = [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }]
    const result = await runIdeation({ spec, fails, prior: null, briefText: 'BRIEF', stateDir, io })
    expect(result.ideation).toEqual({ hypotheses: [{ gateId: 'C8.1a', cause: 'owner fill missing', firstEdit: 'gilded/ui/widgets.py' }], order: ['C8.1a'], trap: 'do not touch palette.py' })
    expect(result.taskPath).toContain('ideation')
    expect(result.outcomePath).toContain('ideation')
  })
})
