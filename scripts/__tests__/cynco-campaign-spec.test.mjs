import { describe, it, expect } from 'vitest'
import { loadCampaignSpec, checkIdentity, SPEC_ENV_KEYS } from '../cynco-campaign-spec.mjs'
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
  it('accepts the optional sweep cap and prBase, and refuses nonsense in either', () => {
    const s = good(); s.sweep = { max: 6 }; s.prBase = 'mission-invariants'
    const loaded = loadCampaignSpec(write(s))
    expect(loaded.sweep).toEqual({ max: 6 })
    expect(loaded.prBase).toBe('mission-invariants')
    expect(loadCampaignSpec(write(good())).sweep).toBeUndefined()
    expect(() => loadCampaignSpec(write({ ...good(), sweep: { max: 0 } }))).toThrow(/sweep.max/)
    expect(() => loadCampaignSpec(write({ ...good(), sweep: { max: 2.5 } }))).toThrow(/sweep.max/)
    expect(() => loadCampaignSpec(write({ ...good(), prBase: '' }))).toThrow(/prBase/)
  })
  // The positive shim (Rule 14) and the provenance of the gate. `positive` is
  // OPTIONAL because the hand-authored c8 spec has none and must keep loading;
  // `author` defaults to 'human' so every spec written before CynCo could
  // author a gate reads as human-authored rather than as unknown.
  it('accepts the optional positive shim and the authorship fields', () => {
    const s = good()
    s.positive = 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/positive_c8.py'
    s.author = 'cynco'
    s.authorMissionId = 'c8-author-wave1-1'
    const loaded = loadCampaignSpec(write(s))
    expect(loaded.positive).toBe(s.positive)
    expect(loaded.author).toBe('cynco')
    expect(loaded.authorMissionId).toBe('c8-author-wave1-1')
  })
  // F161: `env` carries the engine's explicit llama-server / GGUF paths for a
  // campaign under a temp CYNCO_HOME. Harness knobs only.
  it('accepts env with exactly the two runtime-asset keys and refuses every other key (review B-I1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-env-'))
    const write = (env) => { const p = join(dir, `${Math.random().toString(36).slice(2)}.campaign.json`); writeFileSync(p, JSON.stringify({ ...good(), env })); return p }
    expect(SPEC_ENV_KEYS).toEqual(['LOCALCODE_LLAMA_SERVER', 'LOCALCODE_MODEL_PATH'])
    expect(loadCampaignSpec(write({ LOCALCODE_LLAMA_SERVER: 'C:/x/llama-server.exe', LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' })).env)
      .toEqual({ LOCALCODE_LLAMA_SERVER: 'C:/x/llama-server.exe', LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' })
    expect(loadCampaignSpec(write({ LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' })).env).toEqual({ LOCALCODE_MODEL_PATH: 'C:/x/m.gguf' })
    expect(loadCampaignSpec(write(undefined)).env).toBeUndefined()
    expect(() => loadCampaignSpec(write(['LOCALCODE_X=1']))).toThrow(/env must be an object/)
    // The keys a wider allowlist would have let through, each named by the review.
    for (const k of ['PATH', 'CYNCO_HOME', 'LOCALCODE_CACHE_RAM', 'LOCALCODE_API_KEY', 'LOCALCODE_PROVIDER', 'LOCALCODE_IMMUTABLE_PATHS', 'CYNCO_NTFY_URL', 'GH_TOKEN']) {
      expect(() => loadCampaignSpec(write({ [k]: 'x' })), k).toThrow(new RegExp(`env\\.${k}: a spec may set only LOCALCODE_LLAMA_SERVER and LOCALCODE_MODEL_PATH`))
    }
    expect(() => loadCampaignSpec(write({ LOCALCODE_MODEL_PATH: '' }))).toThrow(/must be a non-empty string/)
    expect(() => loadCampaignSpec(write({ LOCALCODE_MODEL_PATH: 3 }))).toThrow(/must be a non-empty string/)
  })

  it('defaults author to human and authorMissionId to null, and leaves positive unset', () => {
    const loaded = loadCampaignSpec(write(good()))
    expect(loaded.author).toBe('human')
    expect(loaded.authorMissionId).toBeNull()
    expect(loaded.positive).toBeUndefined()
  })
  it('refuses an author that is neither cynco nor human, and nonsense in the other two', () => {
    expect(() => loadCampaignSpec(write({ ...good(), author: 'robot' }))).toThrow(/author must be "cynco" or "human"/)
    expect(() => loadCampaignSpec(write({ ...good(), author: '' }))).toThrow(/author must be/)
    expect(() => loadCampaignSpec(write({ ...good(), positive: '' }))).toThrow(/positive must be a non-empty string/)
    expect(() => loadCampaignSpec(write({ ...good(), positive: 3 }))).toThrow(/positive must be a non-empty string/)
    expect(() => loadCampaignSpec(write({ ...good(), authorMissionId: 7 }))).toThrow(/authorMissionId must be a string or null/)
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
  // The positive shim names every graded fact AND how to make it true: it is
  // the answer key, and it is sealed on the same terms as the gate.
  it('holds the positive shim to the same seal as the gate when the spec has one', () => {
    const sealed = { ...good(), positive: 'C:/Users/civer/.cynco/heldout/civkings-redesign/c8/positive_c8.py' }
    expect(checkIdentity(sealed, io())).toEqual({ ok: true, problems: [] })
    expect(checkIdentity({ ...sealed, positive: 'C:/tmp/positive_c8.py' }, io()).problems.join()).toMatch(/positive must live under/)
    expect(checkIdentity(sealed, io({ exists: (p) => !p.includes('positive') })).problems.join()).toMatch(/positive does not exist/)
    expect(checkIdentity({ ...sealed, measures: 'run positive_c8.py' }, io()).problems.join()).toMatch(/positive_c8\.py/)
  })
  it('says nothing about a positive shim the spec does not declare', () => {
    expect(checkIdentity(good(), io({ exists: (p) => !p.includes('positive') }))).toEqual({ ok: true, problems: [] })
  })
  it('refuses a base the repo does not have', () => {
    expect(checkIdentity(good(), io({ gitHasCommit: () => false })).problems.join()).toMatch(/1d03308/)
  })
  // Every field below reaches the worker verbatim through cynco-brief.mjs, so
  // naming the sealed gate in any of them is the same leak as naming it in
  // `measures` — which was the only field scanned.
  it('scans the title, KEEP-GREEN command, allow lists and deny list too', () => {
    for (const patch of [
      { title: 'presentation (see gate_c8.py)' },
      { keepGreen: 'python -m pytest gilded/tests/test_c8_audio.py ~/.cynco/heldout/x.py -q' },
      { allow: { newFiles: ['heldout/scratch.py'], edit: ['gilded/ui/atlas_view.py'] } },
      { allow: { newFiles: ['gilded/ui/transitions.py'], edit: ['perturb_c8.py'] } },
      { deny: ['anything under heldout'] },
    ]) {
      const s = { ...good(), ...patch }
      expect(checkIdentity(s, io()).ok).toBe(false)
    }
  })
})
