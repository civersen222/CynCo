// Phase 5 Task 1: the runner moves its roadmap line. `sealed → running` at the
// first dispatch, `running → done` at a PASS; a campaign that is not on the
// roadmap (the s1 smoke campaign) changes nothing; a `done` line stays `done`.
// Every roadmap here is a temp file — the live docs/…/roadmap.json is never
// read or written by this file.
import { describe, it, expect, afterEach } from 'vitest'
import { runWave, moveRoadmapLine, roadmapFileIn, defaultIo } from '../cynco-campaign.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { defaultIo as calibrateIo } from '../cynco-campaign-calibrate.mjs'
import { ROADMAP_PATH } from '../cynco-roadmap.mjs'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const tmp = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })
const tempDir = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmp.push(d); return d }

// Stand-in instruments under a temp heldout tree, as cynco-campaign.test.mjs does
// (the identity assertion refuses an instrument outside `.cynco/heldout/`).
const HELDOUT = join(mkdtempSync(join(tmpdir(), 'inst-rm-')), '.cynco', 'heldout', 'c9')
mkdirSync(HELDOUT, { recursive: true })
const standIn = (src, name) => { const p = join(HELDOUT, name); copyFileSync(fileURLToPath(new URL(src, import.meta.url)), p); return p }
const GATE = standIn('../cynco-campaign-grade.mjs', 'gate_c9.py')
const PERTURB = standIn('../cynco-campaign-spec.mjs', 'perturb_c9.py')

const specFor = (id) => ({ id, title: 't', repo: 'C:/repo', base: '1d03308', marker: `stage ${id} complete`, keepGreen: 'python -m pytest a.py -q',
  gate: GATE, perturb: PERTURB,
  budget: { hoursPerWave: 1, iterations: 100, bashTimeoutMs: 1000, waves: 3 }, invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
  posiwid: { sourceEditShare: 0.15, commitEvery: 150 }, allow: { newFiles: ['gilded/ui/x.py'], edit: ['gilded/ui/y.py'] },
  deny: [], measures: 'M', work: [{ id: 1, title: 'W', gateIds: ['C9.1a'], text: 't' }], rules: [], ideation: { enabled: false } })

const freshState = (id) => {
  const state = new CampaignState(join(tempDir('camp-rm-'), id)).load()
  state.state.calibration = { gateSha256: calibrateIo.sha256(GATE), perturbSha256: calibrateIo.sha256(PERTURB), baseFails: [{ id: 'C9.1a', line: 'C9.1a: FAIL x' }], basePasses: [] }
  state.state.lastBase = '1d03308'; state.state.lastFails = ['C9.1a']
  return state
}

const miss = { sha: 'h', verified: false, gate: { terminator: 'MISS', fails: [{ id: 'C9.1a', line: 'C9.1a: FAIL x' }], passes: [], failCount: 1, errors: [], harnessFault: null, exit: 1, priorRegressions: 0 }, suite: { exit: 0, regressions: [], repairs: [], harnessFault: null }, sweep: { kind: 'derived', killed: 1, total: 1, survived: [] }, posiwid: { verdict: 'Consistent', divergence: 0, dominantObserved: 'inspect' } }
const pass = { ...miss, verified: true, gate: { ...miss.gate, terminator: 'PASS', fails: [], passes: [{ id: 'C9.1a', line: 'C9.1a: PASS x' }], failCount: 0, exit: 0 } }

/** An io that dispatches, sees one landed row, and grades it `grade`. Records the roadmap status the dispatch saw. */
const ioFor = (grade, roadmapPath, seen = {}) => ({
  writeBrief: (path) => path,
  dispatch: async () => { seen.atDispatch = roadmapPath ? JSON.parse(readFileSync(roadmapPath, 'utf8')).lines.map(l => `${l.id}:${l.status}`) : null; return { missionId: 'm1' } },
  waitForDriver: async () => ({ exited: true }),
  readRow: (missionId) => ({ missionId, exitReason: 'marker', durationS: 100, commitRange: { base: '1d03308', head: 'h' }, outcome: 'landed', markerSeen: true, toolStats: { total: 10, commits: 1, byClass: { sourceEdit: 2, fileWrite: 0, inspect: 8 }, byName: {} } }),
  commitsBetween: () => [{ sha: 'h', subject: 'C9 commit 1' }],
  grade: async () => grade, checkIdentity: () => ({ ok: true, problems: [] }),
  salvageOf: () => null, ideate: async () => ({ ideation: null }),
  patchRow: () => {}, commit: (args) => { seen.committed = args.files; return { sha: 'v1' } },
  notify: async () => true, economics: () => [], appendLog: () => {},
  exportTriples: () => ({ summary: { denials: {}, quiet: {}, campaigns: {} } }), analyseDenials: () => null,
  exportGateLines: () => ({ rows: [], summary: null }), exportGateOutcomes: () => ({ rows: [], outPath: null }),
  readLedgerRows: () => [], datasetsHome: () => tempDir('ds-rm-'),
})

const roadmapWith = (lines) => {
  const p = join(tempDir('roadmap-'), 'roadmap.json')
  writeFileSync(p, JSON.stringify({ lines: lines.map(([id, status]) => ({ id, name: id, bar: 'b', base: '1d03308', status })) }, null, 2) + '\n')
  return p
}
const statusOf = (p, id) => JSON.parse(readFileSync(p, 'utf8')).lines.find(l => l.id === id)?.status

describe('runWave moves the roadmap line', () => {
  it('sealed → running before the first dispatch; a MISS leaves it running', async () => {
    const rm = roadmapWith([['c8', 'done'], ['c9', 'sealed']])
    const seen = {}
    const rec = await runWave(specFor('c9'), freshState('c9'), ioFor(miss, rm, seen), { roadmapPath: rm })
    expect(rec.decision.kind).toBe('next')
    expect(seen.atDispatch).toEqual(['c8:done', 'c9:running'])
    expect(statusOf(rm, 'c9')).toBe('running')
    expect(statusOf(rm, 'c8')).toBe('done')
  })

  it('running → done on a PASS', async () => {
    const rm = roadmapWith([['c9', 'running']])
    const rec = await runWave(specFor('c9'), freshState('c9'), ioFor(pass, rm), { roadmapPath: rm })
    expect(rec.decision.kind).toBe('pass')
    expect(statusOf(rm, 'c9')).toBe('done')
  })

  it('a sealed line that passes on its first wave ends done', async () => {
    const rm = roadmapWith([['c9', 'sealed']])
    await runWave(specFor('c9'), freshState('c9'), ioFor(pass, rm), { roadmapPath: rm })
    expect(statusOf(rm, 'c9')).toBe('done')
  })

  it('a spec id absent from the roadmap (the s1 smoke campaign) changes nothing, byte for byte', async () => {
    const rm = roadmapWith([['c9', 'sealed']])
    const before = readFileSync(rm, 'utf8')
    const rec = await runWave(specFor('s1'), freshState('s1'), ioFor(pass, rm), { roadmapPath: rm })
    expect(rec.decision.kind).toBe('pass')
    expect(readFileSync(rm, 'utf8')).toBe(before)
  })

  it('a done line stays done — no throw, the wave is not faulted', async () => {
    const rm = roadmapWith([['c9', 'done']])
    const rec = await runWave(specFor('c9'), freshState('c9'), ioFor(pass, rm), { roadmapPath: rm })
    expect(rec.decision.kind).toBe('pass')
    expect(statusOf(rm, 'c9')).toBe('done')
  })

  it('an injected io with no roadmapPath moves nothing (a fake wave never touches the live roadmap)', async () => {
    const seen = {}
    await runWave(specFor('c9'), freshState('c9'), ioFor(pass, null, seen))
    expect(seen.atDispatch).toBeNull()
    // The default io alone defaults to the checked-in roadmap.
    expect(defaultIo.roadmapPath).toBeUndefined()
    expect(ROADMAP_PATH).toBe('docs/civkings-redesign-briefs/roadmap.json')
  })
})

// Final review I1: the `done` move runs just before the verdict commit (spec
// §3), after every step that can throw, and the fault path commits the roadmap
// whenever THIS wave moved it. `roadmapFileIn` is seamed so the pathspec is
// visible without the temp roadmap living inside the repo.
describe('the done move sits just before the commit (final review I1)', () => {
  const PATHSPEC = 'docs/civkings-redesign-briefs/roadmap.json'
  const commitsInto = (seen) => (args) => { (seen.commits ??= []).push({ files: args.files, message: args.message }); return { sha: 'v1' } }

  it('a PASS whose appendLog throws → wave fault, the line still running, no roadmap in the fault commit', async () => {
    const rm = roadmapWith([['c9', 'running']])
    const seen = {}
    const io = { ...ioFor(pass, rm, seen), roadmapFileIn: () => [PATHSPEC], commit: commitsInto(seen),
      appendLog: () => { throw new Error('campaign-log.md is locked') } }
    const rec = await runWave(specFor('c9'), freshState('c9'), io, { roadmapPath: rm })
    expect(rec.decision.kind).toBe('fault')
    expect(rec.decision.why).toContain('campaign-log.md is locked')
    expect(statusOf(rm, 'c9')).toBe('running')
    expect(seen.commits).toHaveLength(1)
    expect(seen.commits[0].message).toContain('faulted')
    expect(seen.commits[0].files).not.toContain(PATHSPEC)
  })

  it('a PASS whose commit throws → the line is done and the roadmap was in the attempted commit', async () => {
    const rm = roadmapWith([['c9', 'running']])
    const seen = {}
    const io = { ...ioFor(pass, rm, seen), roadmapFileIn: () => [PATHSPEC],
      commit: (args) => { (seen.commits ??= []).push({ files: args.files }); throw new Error('index.lock exists') } }
    const rec = await runWave(specFor('c9'), freshState('c9'), io, { roadmapPath: rm })
    // commitVerdict's throw is logged, not a fault (the verdict is on the record).
    expect(rec.decision.kind).toBe('pass')
    expect(statusOf(rm, 'c9')).toBe('done')
    expect(seen.commits).toHaveLength(1)
    expect(seen.commits[0].files).toContain(PATHSPEC)
  })

  it('a throw AFTER the done move → the fault commit carries the roadmap, so the next invocation is not refused as dirty', async () => {
    const rm = roadmapWith([['c9', 'running']])
    const seen = {}
    const state = freshState('c9')
    // rewriteLastWave runs after the verdict commit; its first call throws, the
    // fault path's own rewrite then succeeds.
    const real = state.rewriteLastWave.bind(state)
    let thrown = false
    state.rewriteLastWave = (rec) => { if (!thrown) { thrown = true; throw new Error('waves.jsonl is locked') } return real(rec) }
    const io = { ...ioFor(pass, rm, seen), roadmapFileIn: () => [PATHSPEC], commit: commitsInto(seen) }
    const rec = await runWave(specFor('c9'), state, io, { roadmapPath: rm })
    expect(rec.decision.kind).toBe('fault')
    expect(statusOf(rm, 'c9')).toBe('done')
    expect(seen.commits).toHaveLength(2)
    expect(seen.commits[0].files).toContain(PATHSPEC)
    expect(seen.commits[1].message).toContain('faulted')
    expect(seen.commits[1].files).toContain(PATHSPEC)
  })

  it('a dispatch that throws after sealed → running commits the roadmap on the fault path', async () => {
    const rm = roadmapWith([['c9', 'sealed']])
    const seen = {}
    const io = { ...ioFor(miss, rm, seen), roadmapFileIn: () => [PATHSPEC], commit: commitsInto(seen),
      dispatch: async () => { throw new Error('dispatch-mission.sh exit 1') } }
    const rec = await runWave(specFor('c9'), freshState('c9'), io, { roadmapPath: rm })
    expect(rec.decision.kind).toBe('fault')
    expect(statusOf(rm, 'c9')).toBe('running')
    expect(seen.commits[0].files).toContain(PATHSPEC)
  })
})

// Final review T7-M1 (F163): before a wave is dispatched the repo's HEAD must
// be the wave's base (`s.lastBase ?? spec.base`). A mismatch is a STOP — nothing
// ran — naming both shas; nothing is dispatched and the roadmap never moves.
describe('the repo HEAD must be the wave base before dispatch (T7-M1)', () => {
  const FULL = '1d03308aaaabbbbccccddddeeeeffff000011112'
  const OTHER = '17cd9a6000011112222333344445555666677778'
  const shas = (head) => (repo, rev) => ({ HEAD: head, '1d03308': FULL, [FULL]: FULL })[rev] ?? null

  it('HEAD elsewhere → stop naming both shas, nothing dispatched, the roadmap untouched, no wave spent', async () => {
    const rm = roadmapWith([['c9', 'sealed']])
    const before = readFileSync(rm, 'utf8')
    const seen = { dispatched: 0 }
    const state = freshState('c9')
    const io = { ...ioFor(miss, rm, seen), repoHead: shas(OTHER), dispatch: async () => { seen.dispatched++; return { missionId: 'm1' } } }
    const rec = await runWave(specFor('c9'), state, io, { roadmapPath: rm })
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toContain(`repo HEAD ${OTHER} is not the wave base 1d03308 (${FULL})`)
    expect(rec.decision.why).toContain('calibration and dispatch must look at one commit (Rule 11, F163)')
    expect(seen.dispatched).toBe(0)
    expect(readFileSync(rm, 'utf8')).toBe(before)
    expect(state.state.waveCount ?? 0).toBe(0)
  })

  it('an unresolvable base or HEAD is a stop too, never a guess', async () => {
    const seen = { dispatched: 0 }
    const io = { ...ioFor(miss, null, seen), repoHead: () => null, dispatch: async () => { seen.dispatched++; return {} } }
    const rec = await runWave(specFor('c9'), freshState('c9'), io)
    expect(rec.decision.kind).toBe('stop')
    expect(rec.decision.why).toContain('repo HEAD (unresolved) is not the wave base 1d03308 (unresolved)')
    expect(seen.dispatched).toBe(0)
  })

  it('HEAD at the base (an abbreviated base resolves to the same commit) → dispatched', async () => {
    const rm = roadmapWith([['c9', 'sealed']])
    const seen = {}
    const rec = await runWave(specFor('c9'), freshState('c9'), { ...ioFor(miss, rm, seen), repoHead: shas(FULL) }, { roadmapPath: rm })
    expect(rec.decision.kind).toBe('next')
    expect(seen.atDispatch).toEqual(['c9:running'])
  })

  it('a later wave compares against the last graded HEAD (s.lastBase), not spec.base', async () => {
    const state = freshState('c9')
    state.state.lastBase = OTHER
    const asked = []
    const io = { ...ioFor(miss, null), repoHead: (repo, rev) => { asked.push(rev); return rev === 'HEAD' || rev === OTHER ? OTHER : FULL } }
    const rec = await runWave(specFor('c9'), state, io)
    expect(asked).toEqual(['HEAD', OTHER])
    expect(rec.decision.kind).toBe('next')
  })

  it('the default io carries the real read; main hands runWave the default io', () => {
    expect(typeof defaultIo.repoHead).toBe('function')
    const src = readFileSync(fileURLToPath(new URL('../cynco-campaign.mjs', import.meta.url)), 'utf8')
    expect(src).toMatch(/await runWave\(spec, state, defaultIo, \{ roadmapPath \}\)/)
  })

  it('defaultIo.repoHead resolves HEAD and an abbreviated sha in a real temp repo; garbage is null', () => {
    const repo = tempDir('repohead-')
    const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
    writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', 'a.txt'); git('commit', '-q', '-m', 'a')
    const full = git('rev-parse', 'HEAD').stdout.trim()
    expect(defaultIo.repoHead(repo, 'HEAD')).toBe(full)
    expect(defaultIo.repoHead(repo, full.slice(0, 7))).toBe(full)
    expect(defaultIo.repoHead(repo, 'deadbeefnope')).toBeNull()
  })
})

describe('moveRoadmapLine', () => {
  it('forward-only: a refusal from setLineStatus is caught and logged, the file untouched', () => {
    const rm = roadmapWith([['c9', 'done']])
    const before = readFileSync(rm, 'utf8')
    // `done` is not in `from`, so the move is refused before setLineStatus runs.
    expect(moveRoadmapLine(rm, 'c9', 'running', ['sealed'])).toBe(false)
    // Even a caller that lists `done` as a legal source cannot move it backward:
    // setLineStatus throws, and the throw is caught.
    expect(() => moveRoadmapLine(rm, 'c9', 'running', ['done'])).not.toThrow()
    expect(moveRoadmapLine(rm, 'c9', 'running', ['done'])).toBe(false)
    expect(readFileSync(rm, 'utf8')).toBe(before)
  })

  it('an unreadable roadmap is logged, not thrown', () => {
    expect(moveRoadmapLine(join(tempDir('nort-'), 'missing.json'), 'c9', 'running', ['sealed'])).toBe(false)
  })

  it('no roadmap path is a no-op', () => {
    expect(moveRoadmapLine(null, 'c9', 'running', ['sealed'])).toBe(false)
  })

  it('a roadmap inside the repo joins the wave commit as a repo-relative path; one outside never does', async () => {
    // Pure path arithmetic — the checked-in file is named, never opened.
    expect(roadmapFileIn(ROADMAP_PATH)).toEqual(['docs/civkings-redesign-briefs/roadmap.json'])
    const rm = roadmapWith([['c9', 'sealed']])
    expect(roadmapFileIn(rm)).toEqual([])
    const seen = {}
    await runWave(specFor('c9'), freshState('c9'), ioFor(pass, rm, seen), { roadmapPath: rm })
    expect(statusOf(rm, 'c9')).toBe('done')
    expect(seen.committed.some(f => f.includes('roadmap'))).toBe(false)
  })
})
