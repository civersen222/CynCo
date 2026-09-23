import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseIdeation, measureFollowed, authorityRegistry, promotionProposal, ideationPrompt, runIdeation, capProposal, effectiveInvariants, CAP_PROPOSAL_FACTOR } from '../cynco-ideation.mjs'

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
  // Which hypothesis counts is the numerator of the promotion evidence, so it
  // must not be a lottery over whichever one the model listed first: it is the
  // hypothesis for the FIRST FAIL line in the wave's context.
  it('scores the hypothesis for the first FAIL line, by prefix, not the first listed', () => {
    const idea = { hypotheses: [
      { gateId: 'C8.5.palette.Atlas', cause: 'x', firstEdit: 'gilded/ui/widgets.py' },
      { gateId: 'C8.1b', cause: 'y', firstEdit: 'gilded/ui/atlas_view.py' },
    ], order: [], trap: null }
    const fails = [{ id: 'C8.1b.tiers-differ', line: 'C8.1b.tiers-differ: FAIL' }, { id: 'C8.5.palette.Atlas', line: 'C8.5.palette.Atlas: FAIL' }]
    expect(measureFollowed(idea, ['gilded/ui/atlas_view.py'], fails)).toBe(true)
    expect(measureFollowed(idea, ['gilded/ui/widgets.py'], fails)).toBe(false)
    // no hypothesis for the first FAIL line — fall back to the first with a firstEdit
    expect(measureFollowed(idea, ['gilded/ui/widgets.py'], [{ id: 'C8.3a', line: 'C8.3a: FAIL' }])).toBe(true)
    // no fails handed in at all — same fallback
    expect(measureFollowed(idea, ['gilded/ui/widgets.py'])).toBe(true)
  })
  it('the deterministic generator commands the brief until ideation earns authority', () => {
    expect(authorityRegistry({ ideationAuthority: 0 }).whoCommands('brief')?.component).toBe('generator')
    expect(authorityRegistry({ ideationAuthority: 0.5 }).whoCommands('brief')?.component).toBe('generator')
  })
  // Phase 3: the same shape, one context over. 0.5 is the most the gate-author
  // seat is ever granted, so the supervisor never stops commanding `gate`.
  it('the supervisor commands the gate at every authority the gate-author can earn', () => {
    expect(authorityRegistry({ gateAuthorAuthority: 0 }).whoCommands('gate')?.component).toBe('supervisor')
    expect(authorityRegistry({ gateAuthorAuthority: 0.5 }).whoCommands('gate')?.component).toBe('supervisor')
    expect(authorityRegistry({}).whoCommands('gate')?.component).toBe('supervisor')
  })
  it('keeps the two contexts separate — a gate authority never commands the brief', () => {
    const reg = authorityRegistry({ ideationAuthority: 0, gateAuthorAuthority: 0.5 })
    expect(reg.whoCommands('brief')?.component).toBe('generator')
    expect(reg.whoCommands('gate')?.score).toBe(1.0)
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

describe('cap proposals and effective invariants', () => {
  const spec = { invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true } }
  const inert = (invariant) => ({ invariant, denials: 80, complied: 2, changed: 3, compliedRate: 0.025, ci: [0.01, 0.09], baseRate: 0.3, p: 0.0001, pAdjusted: 0.0002, verdict: 'INERT' })
  const quiet = (invariant) => ({ invariant, denials: 3, complied: 1, changed: 1, compliedRate: 0.33, ci: [0.06, 0.79], baseRate: 0.3, p: null, pAdjusted: null, verdict: 'TOO FEW' })

  it('effectiveInvariants overlays approved overrides on the spec caps and nothing else', () => {
    expect(effectiveInvariants(spec, { invariantOverrides: {} })).toEqual(spec.invariants)
    expect(effectiveInvariants(spec, {})).toEqual(spec.invariants)
    expect(effectiveInvariants(spec, { invariantOverrides: { editGapCap: 60, revertBan: false } })).toEqual({ ...spec.invariants, editGapCap: 60 })
  })
  it('proposes raising an INERT cap by 50% within [spec, 2×spec]', () => {
    const p = capProposal({ invariants: [inert('edit-gap'), quiet('commit-gap')] }, spec, { invariantOverrides: {}, proposals: [] })
    expect(CAP_PROPOSAL_FACTOR).toBe(1.5)
    expect(p).toMatchObject({ type: 'Parameter', name: 'invariants/editGapCap', newValue: 60, currentValue: 40, bounds: { min: 40, max: 80 }, status: 'pending' })
    expect(p.evidence.verdict).toBe('INERT')
  })
  it('raises from the current effective cap and never past the bound', () => {
    const p = capProposal({ invariants: [inert('edit-gap')] }, spec, { invariantOverrides: { editGapCap: 60 }, proposals: [] })
    expect(p.newValue).toBe(80)
    expect(p.currentValue).toBe(60)
    expect(capProposal({ invariants: [inert('edit-gap')] }, spec, { invariantOverrides: { editGapCap: 80 }, proposals: [] })).toBeNull()
  })
  it('never proposes for revert, for a non-INERT verdict, or while a proposal is pending', () => {
    expect(capProposal({ invariants: [{ ...inert('revert'), verdict: 'IDENTITY' }] }, spec, { invariantOverrides: {}, proposals: [] })).toBeNull()
    expect(capProposal({ invariants: [quiet('edit-gap')] }, spec, { invariantOverrides: {}, proposals: [] })).toBeNull()
    expect(capProposal({ invariants: [inert('edit-gap')] }, spec, { invariantOverrides: {}, proposals: [{ name: 'ideation/brief', status: 'pending' }] })).toBeNull()
    expect(capProposal(null, spec, { invariantOverrides: {}, proposals: [] })).toBeNull()
  })
})
