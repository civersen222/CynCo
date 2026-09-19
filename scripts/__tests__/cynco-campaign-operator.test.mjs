// The operator's verbs against a LIVE campaign: the lock they must not need,
// the proposal decision the runner must not clobber, the notification queue
// that must not drop what it could not send, and the two loader/wait rules
// that were parked at the plan-3 review (progress.md lines 97–100).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { takeLock, releaseLock, drainQueued, defaultIo, applyProposalDecision } from '../cynco-campaign.mjs'
import { CampaignState, freshState } from '../cynco-campaign-state.mjs'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'

const dir = (p) => mkdtempSync(join(tmpdir(), p))

describe('takeLock is an atomic claim', () => {
  it('removes an unreadable lock left by a writer that died between open and write', () => {
    const d = dir('camp-lock-')
    writeFileSync(join(d, 'runner.lock'), '')
    const r = takeLock(d)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(d, 'runner.lock'), 'utf8')).toBe(String(process.pid))
    releaseLock(d)
  })

  it('refuses when the file appears between the stale-removal and the claim', () => {
    // Simulate the race by handing takeLock a directory where the lock is
    // held by a LIVE pid: the wx open fails, the pid is alive, it refuses —
    // and it does not remove the live holder's file.
    const d = dir('camp-lock-')
    writeFileSync(join(d, 'runner.lock'), String(process.pid))
    const r = takeLock(d)
    expect(r.ok).toBe(false)
    expect(r.pid).toBe(process.pid)
    expect(existsSync(join(d, 'runner.lock'))).toBe(true)
  })
})

describe('drainQueued', () => {
  it('sends what it can and hands back what it could not, in order', async () => {
    const queue = [{ kind: 'a' }, { kind: 'b' }, { kind: 'c' }]
    const sent = []
    const failed = await drainQueued(queue, async (n) => { sent.push(n.kind); return n.kind !== 'b' })
    expect(sent).toEqual(['a', 'b', 'c'])
    expect(failed).toEqual([{ kind: 'b' }])
    expect(queue).toEqual([]) // drained into the local array; the caller reassigns
  })

  it('treats a throwing channel as a failed send, not a lost message', async () => {
    const failed = await drainQueued([{ kind: 'a' }], async () => { throw new Error('ntfy down') })
    expect(failed).toEqual([{ kind: 'a' }])
  })
})

describe('CampaignState.save merges an external proposal decision', () => {
  const proposal = { name: 'ideation/brief', proposedAt: '2026-09-18T00:00:00.000Z', status: 'pending', newValue: 0.5, bounds: { min: 0, max: 0.5 } }

  it('a decision written by --approve-proposal survives the runner\'s next save', () => {
    const d = join(dir('camp-'), 'c8')
    const runner = new CampaignState(d).load()
    runner.state.proposals.push({ ...proposal })
    runner.save()
    // The operator's process: load, decide, save — while `runner` still holds
    // `pending` in memory.
    const operator = new CampaignState(d).load()
    const p = operator.state.proposals[0]
    p.status = 'approved'; p.decidedAt = '2026-09-18T01:00:00.000Z'
    operator.state.ideationAuthority = 0.5
    operator.save()
    // The runner advances a wave and saves its stale in-memory copy.
    runner.state.waveCount = 3
    runner.save()
    const disk = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'))
    expect(disk.waveCount).toBe(3)
    expect(disk.proposals[0].status).toBe('approved')
    expect(disk.proposals[0].decidedAt).toBe('2026-09-18T01:00:00.000Z')
    expect(disk.ideationAuthority).toBe(0.5)
    expect(runner.state.ideationAuthority).toBe(0.5)
  })

  it('a rejection is adopted without touching authority', () => {
    const d = join(dir('camp-'), 'c8')
    const runner = new CampaignState(d).load()
    runner.state.proposals.push({ ...proposal })
    runner.save()
    const operator = new CampaignState(d).load()
    operator.state.proposals[0].status = 'rejected'
    operator.save()
    runner.save()
    const disk = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'))
    expect(disk.proposals[0].status).toBe('rejected')
    expect(disk.ideationAuthority).toBe(0)
  })

  it('does nothing when the disk copy is also pending or is a different proposal', () => {
    const d = join(dir('camp-'), 'c8')
    const runner = new CampaignState(d).load()
    runner.state.proposals.push({ ...proposal })
    runner.save()
    runner.state.proposals.push({ ...proposal, proposedAt: '2026-09-19T00:00:00.000Z' })
    runner.save()
    const disk = JSON.parse(readFileSync(join(d, 'state.json'), 'utf8'))
    expect(disk.proposals.map(p => p.status)).toEqual(['pending', 'pending'])
  })

  it('invariantOverrides merges monotonically: the higher of memory and disk wins, in either direction', () => {
    const capProposal = { name: 'invariants/editGapCap', proposedAt: '2026-09-18T00:00:00.000Z', status: 'pending', newValue: 60, bounds: { min: 40, max: 80 } }

    // Memory (80) higher than the disk decision's overrides (60) — max keeps 80.
    const d1 = join(dir('camp-'), 'c8')
    const runner1 = new CampaignState(d1).load()
    runner1.state.invariantOverrides = { editGapCap: 80 }
    runner1.state.proposals.push({ ...capProposal })
    runner1.save()
    const operator1 = new CampaignState(d1).load()
    operator1.state.proposals[0].status = 'approved'; operator1.state.proposals[0].decidedAt = '2026-09-18T01:00:00.000Z'
    operator1.state.invariantOverrides = { editGapCap: 60 }
    operator1.save()
    runner1.save()
    expect(JSON.parse(readFileSync(join(d1, 'state.json'), 'utf8')).invariantOverrides).toEqual({ editGapCap: 80 })

    // Reverse — memory (60) lower than the disk decision's overrides (80) — max takes 80.
    const d2 = join(dir('camp-'), 'c8')
    const runner2 = new CampaignState(d2).load()
    runner2.state.invariantOverrides = { editGapCap: 60 }
    runner2.state.proposals.push({ ...capProposal })
    runner2.save()
    const operator2 = new CampaignState(d2).load()
    operator2.state.proposals[0].status = 'approved'; operator2.state.proposals[0].decidedAt = '2026-09-18T01:00:00.000Z'
    operator2.state.invariantOverrides = { editGapCap: 80 }
    operator2.save()
    runner2.save()
    expect(JSON.parse(readFileSync(join(d2, 'state.json'), 'utf8')).invariantOverrides).toEqual({ editGapCap: 80 })
  })
})

describe('loadCampaignSpec refuses a leading-glob allow entry', () => {
  const good = () => ({
    id: 'c8', title: 'presentation', repo: 'C:/Users/civer/civkings', base: '1d03308',
    gate: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/gate_c8.py',
    perturb: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/perturb_c8.py',
    suiteBaseline: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/suite_baseline_1d03308.txt',
    marker: 'stage c8 complete', keepGreen: 'python -m pytest gilded/tests/test_c8_audio.py -q',
    budget: { hoursPerWave: 8, iterations: 2000, bashTimeoutMs: 1500000, waves: 8 },
    invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
    posiwid: { sourceEditShare: 0.15, commitEvery: 150 },
    allow: { newFiles: ['gilded/ui/transitions.py'], edit: ['gilded/ui/atlas_view.py'] }, deny: ['gilded/society/*'],
    measures: 'HOW THE GATE MEASURES ...', work: [{ id: 1, title: 'ASSETS IN', gateIds: ['C8.4a'], text: '...' }], rules: ['Deterministic per seed.'],
  })
  const write = (obj) => { const p = join(dir('spec-'), 'c8.campaign.json'); writeFileSync(p, JSON.stringify(obj)); return p }

  it('refuses `**/*.py` and `*.py` in either list, naming the list', () => {
    const a = good(); a.allow.newFiles.push('**/test_c8_*.py')
    expect(() => loadCampaignSpec(write(a))).toThrow(/allow\.newFiles.*starts with a glob/)
    const b = good(); b.allow.edit.push('*.py (any module)')
    expect(() => loadCampaignSpec(write(b))).toThrow(/allow\.edit.*starts with a glob/)
  })

  it('still accepts a glob AFTER a directory prefix (the prefix is what claims)', () => {
    const s = good(); s.allow.newFiles.push('gilded/tests/test_c8_*.py (new test files)')
    expect(loadCampaignSpec(write(s)).allow.newFiles).toHaveLength(2)
  })
})

describe('defaultIo.waitForDriver reads the ledger line before the pid file', () => {
  it('returns the missionId when the ledger line exists and the pid file does not', async () => {
    const r = await defaultIo.waitForDriver({
      pidFile: join(dir('camp-pid-'), 'never-written.pid'), driverLog: 'C:/tmp/d.log', timeoutMs: 5_000,
      missionIdFrom: () => 'c8-wave3-1789',
    })
    expect(r).toEqual({ exited: true, missionId: 'c8-wave3-1789' })
  })

  it('still faults (throws) when neither the ledger line nor the pid file exists', async () => {
    await expect(defaultIo.waitForDriver({
      pidFile: join(dir('camp-pid-'), 'never-written.pid'), driverLog: 'C:/tmp/d.log', timeoutMs: 5_000,
      missionIdFrom: () => null,
    })).rejects.toThrow(/ENOENT/)
  })
})

describe('approving an invariants/* proposal sets an override', () => {
  it('fresh state carries an empty override map', () => { expect(freshState('c8').invariantOverrides).toEqual({}) })
  it('applyProposalDecision writes the bounded override; ideation/brief still sets authority', () => {
    const s = { ...freshState('c8'), proposals: [
      { name: 'invariants/editGapCap', status: 'pending', newValue: 60, bounds: { min: 40, max: 80 } },
      { name: 'ideation/brief', status: 'pending', newValue: 0.5, bounds: { min: 0, max: 0.5 } } ] }
    expect(applyProposalDecision(s, 'invariants/editGapCap', true)).toEqual({ ok: true, status: 'approved' })
    expect(s.invariantOverrides).toEqual({ editGapCap: 60 })
    expect(applyProposalDecision(s, 'ideation/brief', true).ok).toBe(true)
    expect(s.ideationAuthority).toBe(0.5)
    expect(applyProposalDecision(s, 'nope', true)).toEqual({ ok: false, why: 'no pending proposal nope' })
  })
  it('rejecting leaves the overrides alone', () => {
    const s = { ...freshState('c8'), proposals: [{ name: 'invariants/commitGapCap', status: 'pending', newValue: 225, bounds: { min: 150, max: 300 } }] }
    expect(applyProposalDecision(s, 'invariants/commitGapCap', false).status).toBe('rejected')
    expect(s.invariantOverrides).toEqual({})
  })
  it('refuses a proposal naming a non-tunable cap and leaves state untouched', () => {
    const s = { ...freshState('c8'), proposals: [{ name: 'invariants/revertBan', status: 'pending', newValue: false, bounds: { min: false, max: false } }] }
    expect(applyProposalDecision(s, 'invariants/revertBan', true)).toEqual({ ok: false, why: 'proposal invariants/revertBan names a cap that is not tunable' })
    expect(s.invariantOverrides).toEqual({})
    expect(s.proposals[0].status).toBe('pending')
  })
  it('an approval above the bound is clamped to it', () => {
    const s = { ...freshState('c8'), proposals: [{ name: 'invariants/editGapCap', status: 'pending', newValue: 999, bounds: { min: 40, max: 80 } }] }
    applyProposalDecision(s, 'invariants/editGapCap', true)
    expect(s.invariantOverrides.editGapCap).toBe(80)
  })
})
