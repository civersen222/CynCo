import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseIdeation, measureFollowed, authorityRegistry, promotionProposal, ideationPrompt, runIdeation, capProposal, effectiveInvariants, CAP_PROPOSAL_FACTOR } from '../cynco-ideation.mjs'
import { readSeats, writeSeats } from '../cynco-proposals.mjs'
import { testContainment } from '../../engine/containment.js'

// F242: the ideation one-shot starts in a sandbox made for it. These seams stand in for the real
// establish and release, which cannot run in the suite (its sandbox root does not exist).
// Every state folder this file makes is removed when it is done.
const stateDirs = []
const tempState = () => { const d = mkdtempSync(join(tmpdir(), 'cynco-ideation-')); stateDirs.push(d); return d }
afterAll(() => { for (const d of stateDirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function containSeams() {
  const calls = { contain: [], release: [] }
  const ctx = testContainment({
    kind: 'daemon-task', missionCwd: process.cwd(), runId: 'ideation-c8-20261123T120000-abcd',
    sandbox: { root: join(tmpdir(), 'nowhere-root'), home: join(tmpdir(), 'nowhere-home'), tmp: join(tmpdir(), 'nowhere-tmp'), scratch: join(tmpdir(), 'nowhere-scratch') },
    home: tmpdir(), folders: { state: tmpdir(), models: tmpdir(), guard: tmpdir(), audit: null },
  })
  return {
    calls, ctx,
    contain: (a) => { calls.contain.push(a); return { ok: true, containment: ctx, ms: 0 } },
    release: (c) => { calls.release.push(c); return { relabelled: true, note: '' } },
  }
}

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
  // Phase 4: a seat's authority lives in the retained store, not only in the
  // state of the campaign that earned it. Given a home, the registry reads the
  // higher of the two; without one, only the state (the pre-Phase-4 reading).
  it('reads each seat as the max of the campaign state and the retained store', () => {
    const home = mkdtempSync(join(tmpdir(), 'seats-'))
    let seats = readSeats(home)
    seats = writeSeats(home, seats, { seat: 'ideation', authority: 0.5, decidedAt: 't1', campaign: 'c8' })
    writeSeats(home, seats, { seat: 'gate-author', authority: 0.25, decidedAt: 't2', campaign: 'c8' })
    const score = (reg, ctx, who) => reg.potentialCommanders(ctx).find(c => c.component === who)?.score
    const fromStore = authorityRegistry({ ideationAuthority: 0, gateAuthorAuthority: 0 }, { seatsHome: home })
    expect(score(fromStore, 'brief', 'ideation')).toBe(0.5)
    expect(score(fromStore, 'gate', 'gate-author')).toBe(0.25)
    const stateHigher = authorityRegistry({ ideationAuthority: 0, gateAuthorAuthority: 0.5 }, { seatsHome: home })
    expect(score(stateHigher, 'gate', 'gate-author')).toBe(0.5)
    expect(score(authorityRegistry({ ideationAuthority: 0 }), 'brief', 'ideation')).toBe(0)
    expect(fromStore.whoCommands('brief')?.component).toBe('generator')
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
    const stateDir = tempState()
    const outcome = { ok: true, summary: 'one cause', recommendations: [
      { id: 'rec-1', actionType: 'hypothesis', summary: 'C8.1a', detail: 'owner fill missing | firstEdit: gilded/ui/widgets.py' },
      { id: 'rec-2', actionType: 'trap', summary: 'trap', detail: 'do not touch palette.py' } ] }
    const seams = containSeams()
    const io = {
      runTask: async (repoRoot, taskPath, env, cwd) => {
        const task = JSON.parse(readFileSync(taskPath, 'utf8'))
        const { writeFileSync } = await import('node:fs')
        writeFileSync(task.outcomePath, JSON.stringify(outcome))
        return 0
      },
      contain: seams.contain, release: seams.release,
    }
    const spec = { id: 'c8', repo: process.cwd(), work: [] }
    const fails = [{ id: 'C8.1a', line: 'C8.1a: FAIL x' }]
    const result = await runIdeation({ spec, fails, prior: null, briefText: 'BRIEF', stateDir, io })
    expect(result.ideation).toEqual({ hypotheses: [{ gateId: 'C8.1a', cause: 'owner fill missing', firstEdit: 'gilded/ui/widgets.py' }], order: ['C8.1a'], trap: 'do not touch palette.py' })
    expect(result.taskPath).toContain('ideation')
    expect(result.outcomePath).toContain('ideation')
  })

  // F242 (01-isolation 7.4, tests 9.7).
  it('a containment that cannot be made runs no task and says REFUSED: containment', async () => {
    const stateDir = tempState()
    const ran = []
    const released = []
    const said = []
    const err = console.error
    console.error = (...a) => { said.push(a.join(' ')) }
    try {
      const result = await runIdeation({ spec: { id: 'c8', repo: process.cwd(), work: [] }, fails: [], prior: null, briefText: 'B', stateDir, io: {
        runTask: async (...a) => { ran.push(a); return 0 },
        contain: () => ({ ok: false, reason: 'the sandbox root X is not an absolute path to an existing folder' }),
        release: (c) => { released.push(c); return { relabelled: true, note: '' } },
      } })
      expect(result.ideation).toBeNull()
      expect(result.exitCode).toBeNull()
      expect(result.error).toBe('REFUSED: containment: the sandbox root X is not an absolute path to an existing folder')
      expect(ran).toEqual([])
      expect(released).toEqual([])
      expect(existsSync(result.taskPath)).toBe(false)
      expect(said).toContain('[campaign] REFUSED: containment: the sandbox root X is not an absolute path to an existing folder — nothing was run')
    } finally {
      console.error = err
    }
  })

  it('the task file carries the run id and the repository; the child starts in the checkout; release runs once', async () => {
    const stateDir = tempState()
    const seams = containSeams()
    const seen = []
    const repo = join(tmpdir(), 'some-mission-repo')
    const repoRoot = join(tmpdir(), 'the-checkout')
    await runIdeation({ spec: { id: 'c8', repo, work: [] }, fails: [], prior: null, briefText: 'B', stateDir, repoRoot, io: {
      runTask: async (root, taskPath, env, cwd) => { seen.push({ root, cwd, task: JSON.parse(readFileSync(taskPath, 'utf8')) }); return 0 },
      contain: seams.contain, release: seams.release,
    } })
    expect(seams.calls.contain).toEqual([{ kind: 'daemon-task', label: 'ideation-c8', missionCwd: repo, labelCwd: false }])
    expect(seen).toHaveLength(1)
    expect(seen[0].root).toBe(repoRoot)
    expect(seen[0].cwd).toBe(repoRoot)
    expect(seen[0].task.runId).toBe(seams.ctx.runId)
    expect(seen[0].task.cwd).toBe(repo)
    expect(seams.calls.release).toEqual([seams.ctx])
  })

  it('release runs once when the run throws', async () => {
    const stateDir = tempState()
    const seams = containSeams()
    await expect(runIdeation({ spec: { id: 'c8', repo: process.cwd(), work: [] }, fails: [], prior: null, briefText: 'B', stateDir, io: {
      runTask: async () => { throw new Error('spawn blew up') },
      contain: seams.contain, release: seams.release,
    } })).rejects.toThrow('spawn blew up')
    expect(seams.calls.release).toEqual([seams.ctx])
  })

  it('rule H1 in the source: the started bun gets the checkout as its working folder, never the repository', () => {
    const src = readFileSync(new URL('../cynco-ideation.mjs', import.meta.url), 'utf8')
    expect(src).toContain('?? runTask)(repoRoot, taskPath, env, repoRoot)')
    expect(src).not.toContain('taskPath, env, spec.repo)')
    expect(src).toContain('establishContainment')
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
