import { describe, it, expect } from 'vitest'
import { loadCampaignSpec, checkIdentity } from '../cynco-campaign-spec.mjs'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
const write = (obj) => { const p = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c8.campaign.json'); writeFileSync(p, JSON.stringify(obj)); return p }

describe('loadCampaignSpec', () => {
  it('loads a valid spec', () => { expect(loadCampaignSpec(write(good())).id).toBe('c8') })
  it('names the missing field', () => {
    const s = good(); delete s.marker
    expect(() => loadCampaignSpec(write(s))).toThrow(/marker/)
  })
  it('refuses a wildcard in keepGreen (F146)', () => {
    const s = good(); s.keepGreen = 'python -m pytest gilded/tests/test_c8_*.py -q'
    expect(() => loadCampaignSpec(write(s))).toThrow(/wildcard/)
  })
  it('refuses duplicate gateIds across work items', () => {
    const s = good(); s.work.push({ id: 2, title: 'X', gateIds: ['C8.4a'], text: 'y' })
    expect(() => loadCampaignSpec(write(s))).toThrow(/C8.4a/)
  })
})

describe('checkIdentity', () => {
  const io = (over = {}) => ({
    exists: () => true,
    readFile: () => '',
    gitHasCommit: () => true,
    ...over,
  })
  it('passes a clean spec', () => { expect(checkIdentity(good(), io())).toEqual({ ok: true, problems: [] }) })
  it('refuses a gate outside heldout', () => {
    const s = good(); s.gate = 'C:/tmp/gate.py'
    expect(checkIdentity(s, io()).problems.join()).toMatch(/heldout/)
  })
  it('refuses brief text that names the gate', () => {
    const s = good(); s.measures = 'run gate_c8.py to check'
    expect(checkIdentity(s, io()).problems.join()).toMatch(/gate_c8.py/)
  })
  it('refuses a base the repo does not have', () => {
    expect(checkIdentity(good(), io({ gitHasCommit: () => false })).problems.join()).toMatch(/1d03308/)
  })
})
