import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'
import {
  AUTHOR_TIMEOUT_S, AUTHOR_ITERATIONS, AUTHOR_INVARIANTS, GATE_AUTHOR_MAX_AUTHORITY,
  stagingDirFor, heldoutDirFor, prepareStaging, authoringBrief, authoringSidecar, checkCommand,
  checkStaged, authorCampaign, gateProposal, sealGate, draftToSpec, authorMain, previousLineId,
} from '../cynco-gate-author.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'

// ── the world the fake io stands in for ─────────────────────────────────────
//
// checkStaged really lints and really calibrates; only the processes are
// faked. So the staged triple below has to be a triple the lint accepts and
// the gate logs have to be logs cynco-gate-parse.mjs can read — anything less
// would test the fake rather than the verb.

const ID = 'c9'
const LINE = { id: 'c9', name: 'Ship shell', bar: 'Resolutions, keybinds, saves UI, performance guard, packaging', base: 'e9366f37e6f9f0d71e2b0e6584a936d458ec25d3', status: 'open' }
const ROADMAP = () => ({ lines: [
  { id: 'c8', name: 'Presentation', bar: 'Map/art pass, portraits, transitions, ambient music bed per act', base: '1d03308', status: 'done' },
  { ...LINE },
] })

const IDS = ['C9.1a.modes-listed', 'C9.1b.mode-applies', 'C9.2a.keybind-rebinds', 'C9.2b.keybind-persists',
  'C9.3a.save-slots-drawn', 'C9.3b.save-round-trips', 'C9.4a.frame-budget', 'C9.5a.bundle-runs', 'C9.9']

const GATE_SRC = [
  '# gate_c9.py — sealed. Campaign C9: ship shell.',
  'import os, sys, subprocess, runpy',
  'REPO = os.environ.get("CYNCO_GATE_REPO") or r"C:\\Users\\civer\\civkings"',
  'FAILS = []',
  'def check(name, cond, detail):',
  '    print(f"{name}: {\'PASS\' if cond else \'FAIL\'} {detail}")',
  ...IDS.filter(i => i !== 'C9.9').map(i => `check(${JSON.stringify(i)}, False, "x")`),
  'if not os.environ.get("CYNCO_GATE_SKIP_PRIOR"):',
  '    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "gate_c8.py")])',
  '    check("C9.9", r.returncode == 0, "0 prior-campaign regressions")',
  'print("GATE: PASS" if not FAILS else f"GATE: MISS ({len(FAILS)} fails)")',
].join('\n')

const PERTURB_SRC = [
  '# perturb_c9.py — calibration cheat stub for gate_c9.py.',
  '# EXPECT-FLIP: C9.1a',
  '# MUST-FAIL: C9.1b C9.2a C9.2b C9.3a C9.3b C9.4a C9.5a C9.9',
  'import os, runpy',
  'os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"',
  'runpy.run_path("gate_c9.py", run_name="__main__")',
].join('\n')

const POSITIVE_SRC = [
  '# positive_c9.py — Rule 14 shim: makes every graded fact true the cheapest honest way.',
  'import os, runpy',
  'os.environ["CYNCO_GATE_SKIP_PRIOR"] = "1"',
  'runpy.run_path("gate_c9.py", run_name="__main__")',
].join('\n')

const DRAFT = () => ({
  title: 'ship shell',
  keepGreen: 'python -m pytest gilded/tests/test_c9_settings.py gilded/tests/test_c9_saves.py -q',
  measures: 'HOW THE GATE MEASURES — the resolution list is drawn, pressed at its centre, and the next draw is that size.',
  allow: { newFiles: ['gilded/ui/settings_tab.py'], edit: ['gilded/ui/app.py'] },
  deny: ['the sim'],
  rules: ['Use the CodeIndex tool FIRST for every symbol lookup.'],
  work: [
    { id: 1, title: 'RESOLUTIONS', gateIds: ['C9.1a.modes-listed', 'C9.1b.mode-applies'], text: 'draw the mode list' },
    { id: 2, title: 'KEYBINDS', gateIds: ['C9.2a.keybind-rebinds', 'C9.2b.keybind-persists'], text: 'rebind and persist' },
    { id: 3, title: 'SAVES', gateIds: ['C9.3a.save-slots-drawn', 'C9.3b.save-round-trips'], text: 'slots UI' },
    { id: 4, title: 'GUARD', gateIds: ['C9.4a.frame-budget'], text: 'frame budget' },
    { id: 5, title: 'PACKAGING', gateIds: ['C9.5a.bundle-runs'], text: 'one-file bundle' },
  ],
})

const gateLog = (statuses, terminator) => IDS.map(i => `${i}: ${statuses[i] ?? 'FAIL'} detail`).join('\n') + `\n${terminator}\n`
const BASE_LOG = gateLog({}, 'GATE: MISS (9 fails)')
const PERTURB_LOG = gateLog({ 'C9.1a.modes-listed': 'PASS' }, 'GATE: MISS (8 fails)')
const POSITIVE_LOG = gateLog(Object.fromEntries(IDS.map(i => [i, 'PASS'])), 'GATE: PASS')

const norm = (p) => String(p).replace(/\\/g, '/')

function makeIo({ home, files = {}, baseLog = BASE_LOG, perturbLog = PERTURB_LOG, positiveLog = POSITIVE_LOG, row = { missionId: 'c9-author-1', verified: true }, over = {} } = {}) {
  const disk = { ...files }
  const dispatched = [], logs = [], ran = [], copied = []
  const io = {
    mkdir: (p) => { disk[norm(p) + '/'] = '' },
    run: (cmd, args, opts) => {
      const k = [cmd, ...args].join(' ')
      ran.push(k)
      if (/gate_c9\.py/.test(k) && cmd === 'python') return { status: 1, stdout: baseLog, stderr: '' }
      if (/perturb_c9\.py/.test(k)) return { status: 1, stdout: perturbLog, stderr: '' }
      if (/positive_c9\.py/.test(k)) return { status: 0, stdout: positiveLog, stderr: '' }
      if (/pytest/.test(k)) return { status: 1, stdout: 'FAILED gilded/tests/a.py::t1 - x\n', stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    },
    exists: (p) => norm(p) in disk,
    readFile: (p) => { const k = norm(p); if (k in disk) return disk[k]; throw new Error(`ENOENT ${p}`) },
    writeFile: (p, s) => { disk[norm(p)] = s },
    copy: (src, dst) => { copied.push([norm(src), norm(dst)]); disk[norm(dst)] = io.readFile(src) },
    sha256: (p) => createHash('sha256').update(io.readFile(p)).digest('hex').slice(0, 16),
    freshDir: (p) => { disk[norm(p) + '/'] = ''; disk[norm(p)] = '' },
    appendLog: (t) => logs.push(t),
    now: () => '2026-09-23T10:00:00.000Z',
    dispatch: async (a) => { dispatched.push(a); return { driverLog: a.env.DRIVER_LOG } },
    waitForDriver: async () => ({ exited: true, missionId: 'c9-author-1' }),
    missionIdFrom: () => 'c9-author-1',
    readRow: () => row,
    dispatchEnv: (base, extra) => ({ PATH: base.PATH, ...extra }),
    takeLock: () => ({ ok: true, path: 'lock', pid: 1 }),
    releaseLock: () => {},
    gitHasCommit: () => true,
    saveRoadmap: (p, r) => { disk[norm(p)] = JSON.stringify(r, null, 2) + '\n' },
    // The seal's final door is the REAL loader: the fake disk's bytes are
    // written out and handed to loadCampaignSpec, so a spec shape it would
    // refuse cannot pass here either.
    loadSpec: (p) => {
      const tmp = join(mkdtempSync(join(tmpdir(), 'spec-')), basename(norm(p)))
      writeFileSync(tmp, disk[norm(p)])
      return loadCampaignSpec(tmp)
    },
    home,
    ...over,
  }
  return { io, disk, dispatched, logs, ran, copied }
}

/** A staging dir whose four files are already on the fake disk. */
function staged(home, extra = {}) {
  const stagingDir = stagingDirFor(ID, home)
  const files = {
    [`${norm(stagingDir)}/gate_${ID}.py`]: GATE_SRC,
    [`${norm(stagingDir)}/perturb_${ID}.py`]: PERTURB_SRC,
    [`${norm(stagingDir)}/positive_${ID}.py`]: POSITIVE_SRC,
    [`${norm(stagingDir)}/${ID}.campaign.draft.json`]: JSON.stringify(DRAFT(), null, 2),
    [`${norm(stagingDir)}/.git`]: '',
    'C:/tmp/c9_author_base': '',
    ...extra,
  }
  return { stagingDir, files }
}

let home
// `.cynco` is load-bearing: checkIdentity accepts a sealed path only when it
// contains /.cynco/heldout/, so a temp home that skipped that segment would
// pass every test here and refuse every real seal.
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'author-home-')).replace(/\\/g, '/') + '/.cynco' })

describe('staging paths', () => {
  it('stages under <home>/authoring/<id> and seals under <home>/heldout/civkings-redesign/<id>', () => {
    expect(norm(stagingDirFor('c9', home))).toBe(`${home}/authoring/c9`)
    expect(norm(heldoutDirFor('c9', home))).toBe(`${home}/heldout/civkings-redesign/c9`)
  })
  it('quotes both paths in the check command', () => {
    expect(checkCommand('C:/a b/c9', 'C:/tmp/c9_author_base'))
      .toBe('bun scripts/cynco-gate-author.mjs --check "C:/a b/c9" "C:/tmp/c9_author_base"')
  })
  it('the sidecar is one keep-green assertion carrying the check command', () => {
    const s = authoringSidecar({ stagingDir: 'C:/s', baseDir: 'C:/b' })
    expect(s.assertions).toHaveLength(1)
    expect(s.assertions[0]).toMatchObject({ role: 'keep-green', timeoutMs: 7_200_000, command: checkCommand('C:/s', 'C:/b') })
  })
  it('names the previous roadmap line', () => {
    expect(previousLineId(ROADMAP(), 'c9')).toBe('c8')
    expect(previousLineId(ROADMAP(), 'c8')).toBeNull()
  })
})

describe('prepareStaging', () => {
  it('git-inits an absent staging dir, archives the BASE, and copies the previous gate in beside it', () => {
    const { io, ran, disk } = makeIo({ home, files: { [`${home}/heldout/civkings-redesign/c8/gate_c8.py`]: '# gate_c8\n' } })
    const r = prepareStaging({ id: ID, base: LINE.base, repo: 'C:/Users/civer/civkings', prevId: 'c8', io })
    expect(norm(r.stagingDir)).toBe(`${home}/authoring/c9`)
    expect(norm(r.baseDir)).toBe('C:/tmp/c9_author_base')
    expect(ran.some(k => k.startsWith('git init'))).toBe(true)
    expect(ran.some(k => /archive/.test(k) && k.includes(LINE.base))).toBe(true)
    expect(disk[`${home}/authoring/c9/gate_c8.py`]).toBe('# gate_c8\n')
  })
  it('does not re-init a staging dir that already has a .git', () => {
    const { stagingDir, files } = staged(home)
    const { io, ran } = makeIo({ home, files })
    prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', prevId: null, io })
    expect(norm(stagingDir)).toBe(`${home}/authoring/c9`)
    expect(ran.some(k => k.startsWith('git init'))).toBe(false)
  })
})

describe('authoringBrief', () => {
  const build = (over = {}) => authoringBrief({
    line: LINE, id: ID, prevId: 'c8', baseDir: 'C:/tmp/c9_author_base', stagingDir: `${home}/authoring/c9`,
    exemplar: { gateHead: '# gate_c8.py — sealed.\nimport os', perturbHead: '# EXPECT-FLIP: C8.1a\n# MUST-FAIL: C8.1b' }, ...over,
  })

  it('carries every heading, the roadmap line verbatim, the four file names and the check command', () => {
    const t = build()
    for (const h of ['MISSION C9-AUTHOR — WRITE THE SEALED GATE FOR SHIP SHELL', 'THE ROADMAP LINE', 'THE GAME AT BASE',
      'WHAT TO WRITE', 'THE RULES', 'THE DRAFT', 'EXEMPLAR', 'DONE WHEN']) expect(t).toContain(h)
    expect(t).toContain(LINE.bar)
    for (const f of ['gate_c9.py', 'perturb_c9.py', 'positive_c9.py', 'c9.campaign.draft.json']) expect(t).toContain(f)
    expect(t).toContain(checkCommand(`${home}/authoring/c9`, 'C:/tmp/c9_author_base'))
    expect(t).toContain('gate c9 authored')
  })

  // Ruling: the exemplar is read from the sealed directory but the brief is a
  // file a model reads. The path never appears and neither does the word.
  it('never contains the string heldout, even when the exemplar does', () => {
    const t = build({ exemplar: { gateHead: `# read from ${home}/heldout/civkings-redesign/c8/gate_c8.py\nimport os`, perturbHead: '# MUST-FAIL: C8.1b' } })
    expect(t).not.toContain('heldout')
    expect(t).toContain('import os')
  })

  it('names the conventions the lint and the calibration will enforce', () => {
    const t = build()
    expect(t).toContain('CYNCO_GATE_REPO')
    expect(t).toContain('CYNCO_GATE_SKIP_PRIOR')
    expect(t).toContain('check(name, cond, detail)')
    expect(t).toContain('GATE: PASS')
    expect(t).toContain('GATE: MISS (<n> fails)')
    expect(t).toContain('# EXPECT-FLIP:')
    expect(t).toContain('# MUST-FAIL:')
    expect(t).toContain('runpy.run_path')
    expect(t).toContain('C9.9')
    expect(t).toContain('gate_c8.py')
    expect(t).toContain('SDL_VIDEODRIVER=dummy')
    expect(t).toContain('new_app_state(seed=')
    expect(t).toContain('seed 7')
    expect(t).toContain('seed 11')
    expect(t).toMatch(/Rule 11/)
    expect(t).toMatch(/Rule 14/)
    expect(t).toMatch(/Rule 15/)
  })

  it('carries PREVIOUS CHECK OUTPUT only on a resume', () => {
    expect(build()).not.toContain('PREVIOUS CHECK OUTPUT')
    const resumed = build({ previousCheck: 'lint: no graded lines' })
    expect(resumed).toContain('PREVIOUS CHECK OUTPUT')
    expect(resumed).toContain('lint: no graded lines')
    // the nine headings, in this order and no other
    const order = ['MISSION C9-AUTHOR', 'THE ROADMAP LINE', 'THE GAME AT BASE', 'WHAT TO WRITE', 'THE RULES',
      'THE DRAFT', 'EXEMPLAR', 'PREVIOUS CHECK OUTPUT', 'DONE WHEN'].map(h => resumed.indexOf(h))
    expect(order.every((v, i) => v > -1 && (i === 0 || v > order[i - 1]))).toBe(true)
  })

  it('says the archive is read-only', () => {
    expect(build()).toMatch(/read-only/)
  })
})

describe('checkStaged', () => {
  it('passes a triple that lints and calibrates', async () => {
    const { stagingDir, files } = staged(home)
    const { io } = makeIo({ home, files })
    const r = await checkStaged({ id: ID, stagingDir, baseDir: 'C:/tmp/c9_author_base', io })
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.lineIds).toEqual(IDS)
    expect(r.calibration.ok).toBe(true)
  })
  it('reports a missing file without running anything', async () => {
    const { stagingDir, files } = staged(home)
    delete files[`${norm(stagingDir)}/positive_c9.py`]
    const { io, ran } = makeIo({ home, files })
    const r = await checkStaged({ id: ID, stagingDir, baseDir: 'C:/tmp/c9_author_base', io })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/positive_c9\.py/)
    expect(ran.filter(k => k.startsWith('python'))).toEqual([])
  })
  it('reports a BASE that does not MISS', async () => {
    const { stagingDir, files } = staged(home)
    const { io } = makeIo({ home, files, baseLog: POSITIVE_LOG })
    const r = await checkStaged({ id: ID, stagingDir, baseDir: 'C:/tmp/c9_author_base', io })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/BASE must MISS/)
  })
  it('reports a lint problem and a calibration problem together', async () => {
    const { stagingDir, files } = staged(home)
    files[`${norm(stagingDir)}/gate_c9.py`] = GATE_SRC.replace('os.environ.get("CYNCO_GATE_REPO")', '"C:/civkings"')
    const { io } = makeIo({ home, files, baseLog: POSITIVE_LOG })
    const r = await checkStaged({ id: ID, stagingDir, baseDir: 'C:/tmp/c9_author_base', io })
    expect(r.problems.some(p => /CYNCO_GATE_REPO/.test(p))).toBe(true)
    expect(r.problems.some(p => /BASE must MISS/.test(p))).toBe(true)
  })
})

describe('draftToSpec', () => {
  const paths = (h) => ({ gate: `${h}/heldout/civkings-redesign/c9/gate_c9.py`, perturb: `${h}/heldout/civkings-redesign/c9/perturb_c9.py`,
    positive: `${h}/heldout/civkings-redesign/c9/positive_c9.py`, suiteBaseline: `${h}/heldout/civkings-redesign/c9/suite_baseline_e9366f3.txt` })

  it('fills every runner-owned field', () => {
    const spec = draftToSpec({ id: ID, draft: DRAFT(), line: LINE, paths: paths(home), authorMissionId: 'c9-author-1', lineIds: IDS })
    expect(spec).toMatchObject({ id: 'c9', repo: 'C:/Users/civer/civkings', base: LINE.base, marker: 'stage c9 complete',
      author: 'cynco', authorMissionId: 'c9-author-1', prBase: 'main',
      budget: { hoursPerWave: 8, iterations: 2000, bashTimeoutMs: 1500000, waves: 8 },
      invariants: { editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true },
      posiwid: { sourceEditShare: 0.3, commitEvery: 60 }, sweep: { max: 6 }, ideation: { enabled: true } })
    expect(spec.gate).toBe(paths(home).gate)
    expect(spec.suiteBaseline).toBe(paths(home).suiteBaseline)
    expect(spec.title).toBe('ship shell')
  })
  it('refuses a draft with no work items', () => {
    const d = DRAFT(); delete d.work
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })).toThrow(/work/)
  })
  it('refuses a wildcard keepGreen (F146)', () => {
    const d = DRAFT(); d.keepGreen = 'python -m pytest gilded/tests/test_c9_*.py -q'
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })).toThrow(/wildcard/)
  })
  it('refuses gateIds that do not cover every graded line but C<N>.9', () => {
    const d = DRAFT(); d.work = d.work.slice(0, 2)
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })).toThrow(/C9\.3a\.save-slots-drawn/)
  })
  it('does not demand a work item for the regression line', () => {
    const spec = draftToSpec({ id: ID, draft: DRAFT(), line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })
    expect(spec.work.flatMap(w => w.gateIds)).not.toContain('C9.9')
  })
})

describe('authorCampaign', () => {
  const runIt = async (over = {}, extraFiles = {}) => {
    const { files } = staged(home, extraFiles)
    const { io, dispatched, disk } = makeIo({ home, files, ...over })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    return { r, roadmap, state, dispatched, disk, io }
  }

  it('moves the line to authoring, dispatches once with the authoring env, and proposes on a passing check', async () => {
    const { r, roadmap, state, dispatched } = await runIt()
    expect(dispatched).toHaveLength(1)
    const d = dispatched[0]
    expect(d.marker).toBe('gate c9 authored')
    expect(norm(d.cwd)).toBe(`${home}/authoring/c9`)
    expect(d.timeoutS).toBe(AUTHOR_TIMEOUT_S)
    expect(d.checkCmd).toBe(checkCommand(`${home}/authoring/c9`, 'C:/tmp/c9_author_base'))
    expect(d.env.CYNCO_CAMPAIGN_ID).toBe('c9-author')
    expect(norm(d.env.LOCALCODE_LEARNINGS_DB)).toBe(`${home}/authoring/c9/learnings.db`)
    expect(d.env.LOCALCODE_MAX_ITERATIONS).toBe(String(AUTHOR_ITERATIONS))
    expect(JSON.parse(d.env.CYNCO_MISSION_INVARIANTS)).toEqual(AUTHOR_INVARIANTS)
    expect(d.env.CYNCO_SKIP_IDLE_ENGINE).toBe('1')
    expect(d.env.DRIVER_PID_FILE).toBeTruthy()
    expect(r.ok).toBe(true)
    expect(r.proposal).toMatchObject({ type: 'Code', name: 'gate/c9', status: 'pending' })
    expect(r.proposal.evidence).toMatchObject({ lineCount: IDS.length, problems: [], missionId: 'c9-author-1', verified: true })
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
    expect(state.state.proposals.some(p => p.name === 'gate/c9' && p.status === 'pending')).toBe(true)
    expect(state.state.authoring.c9.lastCheck.ok).toBe(true)
  })

  it('writes the brief and its contract sidecar into the staging dir and commits them before dispatch', async () => {
    const { disk, io } = await runIt()
    expect(disk[`${home}/authoring/c9/brief-1.txt`]).toContain('MISSION C9-AUTHOR')
    const sidecar = JSON.parse(disk[`${home}/authoring/c9/brief-1.contract.json`])
    expect(sidecar.assertions[0].role).toBe('keep-green')
    expect(io).toBeTruthy()
  })

  it('leaves the line in authoring with the problems recorded when the check fails', async () => {
    const { r, roadmap, state } = await runIt({ baseLog: POSITIVE_LOG })
    expect(r.ok).toBe(false)
    expect(r.proposal).toBeNull()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
    expect(state.state.authoring.c9.lastCheck.problems.join('\n')).toMatch(/BASE must MISS/)
    expect(state.state.proposals.some(p => p.name === 'gate/c9')).toBe(false)
  })

  it('resumes into the same staging dir with the previous check output in the brief', async () => {
    const { files } = staged(home)
    const { io, disk } = makeIo({ home, files, baseLog: POSITIVE_LOG })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toContain('PREVIOUS CHECK OUTPUT')
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toMatch(/BASE must MISS/)
    expect(state.state.authoring.c9.attempts).toBe(2)
  })

  it('refuses a line that is already sealed', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files })
    const roadmap = ROADMAP(); roadmap.lines.find(l => l.id === 'c9').status = 'sealed'
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/sealed/)
    expect(dispatched).toEqual([])
  })

  // §4: a mission whose instrument never ran is not evidence either way.
  it('proposes nothing when the ledger row is missing', async () => {
    const { r, roadmap } = await runIt({ row: null })
    expect(r.proposal).toBeNull()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
  })
  it('proposes nothing when the mission verified is null', async () => {
    const { r, state } = await runIt({ row: { missionId: 'c9-author-1', verified: null } })
    expect(r.proposal).toBeNull()
    expect(state.state.authoring.c9.verified).toBeNull()
  })
})

describe('gateProposal', () => {
  it('is a Code proposal named for the campaign', () => {
    const p = gateProposal({ id: 'c9', check: { ok: true, problems: [], lineIds: IDS }, missionId: 'm1', verified: true })
    expect(p).toMatchObject({ type: 'Code', name: 'gate/c9', status: 'pending' })
    expect(p.evidence).toEqual({ lineCount: IDS.length, problems: [], missionId: 'm1', verified: true })
    expect(p.description).toContain('c9')
  })
})

describe('sealGate', () => {
  const setup = async (over = {}, draftOver = {}, extraFiles = {}) => {
    const { stagingDir, files } = staged(home, extraFiles)
    if (Object.keys(draftOver).length) files[`${norm(stagingDir)}/${ID}.campaign.draft.json`] = JSON.stringify({ ...DRAFT(), ...draftOver }, null, 2)
    const { io, disk, logs, copied } = makeIo({ home, files, ...over })
    const roadmap = ROADMAP(); roadmap.lines.find(l => l.id === 'c9').status = 'proposed'
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.authoring = { c9: { stagingDir, baseDir: 'C:/tmp/c9_author_base', missionId: 'c9-author-1', verified: true } }
    const r = await sealGate({ id: ID, state, roadmap, io })
    return { r, roadmap, state, disk, logs, copied }
  }

  it('copies the triple to heldout, writes a spec that loads, and marks the line sealed', async () => {
    const { r, roadmap, state, disk, copied } = await setup()
    expect(r.ok).toBe(true)
    expect(copied.map(c => c[1])).toEqual([
      `${home}/heldout/civkings-redesign/c9/gate_c9.py`,
      `${home}/heldout/civkings-redesign/c9/perturb_c9.py`,
      `${home}/heldout/civkings-redesign/c9/positive_c9.py`,
    ])
    const spec = JSON.parse(disk['docs/civkings-redesign-briefs/c9.campaign.json'])
    for (const k of ['gate', 'perturb', 'positive', 'suiteBaseline']) expect(norm(spec[k]).startsWith(`${home}/heldout/civkings-redesign/c9/`)).toBe(true)
    expect(spec.author).toBe('cynco')
    expect(spec.authorMissionId).toBe('c9-author-1')
    expect(disk['docs/civkings-redesign-briefs/c9.campaign.json'].endsWith('\n')).toBe(true)
    expect(disk['docs/civkings-redesign-briefs/c9.campaign.json']).toContain('\n  "id": "c9"')
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('sealed')
    expect(state.state.authoring.c9.sealedAt).toBe('2026-09-23T10:00:00.000Z')
    expect(state.state.authoring.c9.gateSha256).toHaveLength(16)
  })

  it('writes a spec the real loader accepts', async () => {
    const { disk } = await setup()
    const specPath = join(mkdtempSync(join(tmpdir(), 'spec-')), 'c9.campaign.json')
    writeFileSync(specPath, disk['docs/civkings-redesign-briefs/c9.campaign.json'])
    expect(() => loadCampaignSpec(specPath)).not.toThrow()
  })

  it('writes the campaign-log entry', async () => {
    const { logs } = await setup()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^## Campaign C9 — Ship shell \(authored by CynCo, sealed \d{4}-\d{2}-\d{2}, BASE e9366f3, gate_c9\.py sha256 [0-9a-f]{16}\)$/m)
    expect(logs[0]).toContain(LINE.bar)
    expect(logs[0]).toContain('c9-author-1')
    expect(logs[0]).toContain('C9.9')
    expect(logs[0]).toMatch(/MISS/)
    expect(logs[0]).toMatch(/GATE: PASS/)
  })

  it('refuses a draft whose brief-visible text names the sealed gate', async () => {
    const { r, disk } = await setup({}, { measures: 'every fact gate_c9.py grades is drawn' })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/gate_c9\.py/)
    expect('docs/civkings-redesign-briefs/c9.campaign.json' in disk).toBe(false)
  })

  it('never overwrites a sealed gate with a different sha', async () => {
    const { r, disk } = await setup({}, {}, { [`${home}/heldout/civkings-redesign/c9/gate_c9.py`]: '# a human wrote this one\n' })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/already holds/)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe('# a human wrote this one\n')
  })

  it('reseals the identical gate (the same sha is not an overwrite)', async () => {
    const { r } = await setup({}, {}, { [`${home}/heldout/civkings-redesign/c9/gate_c9.py`]: GATE_SRC })
    expect(r.ok).toBe(true)
  })

  it('refuses when the staged triple no longer passes the check', async () => {
    const { r } = await setup({ baseLog: POSITIVE_LOG })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/BASE must MISS/)
  })

  it('refuses when nothing was authored for the id', async () => {
    const { io } = makeIo({ home })
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await sealGate({ id: ID, state, roadmap: ROADMAP(), io })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/nothing staged/)
  })
})

describe('authorMain', () => {
  it('--check exits 0 on a clean triple and 1 on a dirty one', async () => {
    const { stagingDir, files } = staged(home)
    const clean = makeIo({ home, files })
    expect(await authorMain(['--check', stagingDir, 'C:/tmp/c9_author_base'], clean.io)).toBe(0)
    const dirty = makeIo({ home, files, baseLog: POSITIVE_LOG })
    expect(await authorMain(['--check', stagingDir, 'C:/tmp/c9_author_base'], dirty.io)).toBe(1)
  })
  it('--check without both paths is a usage error', async () => {
    const { io } = makeIo({ home })
    expect(await authorMain(['--check'], io)).toBe(2)
  })
  it('--author refuses an id the roadmap does not carry', async () => {
    const { files } = staged(home)
    const { io } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP() } })
    expect(await authorMain(['--author', 'c99'], io)).toBe(2)
  })
  it('--author takes and releases the campaign lock', async () => {
    const { files } = staged(home)
    let released = 0
    const { io } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), releaseLock: () => { released++ } } })
    expect(await authorMain(['--author', ID], io)).toBe(0)
    expect(released).toBe(1)
  })
  it('--author refuses when another runner holds the lock', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), takeLock: () => ({ ok: false, path: 'p', pid: 7 }) } })
    expect(await authorMain(['--author', ID], io)).toBe(2)
    expect(dispatched).toEqual([])
  })
})

describe('constants', () => {
  it('are the budget the spec set', () => {
    expect(AUTHOR_TIMEOUT_S).toBe(14400)
    expect(AUTHOR_ITERATIONS).toBe(1200)
    expect(GATE_AUTHOR_MAX_AUTHORITY).toBe(0.5)
    expect(AUTHOR_INVARIANTS).toEqual({ editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true })
  })
})
