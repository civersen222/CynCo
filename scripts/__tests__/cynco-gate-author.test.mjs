import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'
import {
  AUTHOR_TIMEOUT_S, AUTHOR_ITERATIONS, AUTHOR_INVARIANTS, GATE_AUTHOR_MAX_AUTHORITY,
  GATE_AUTHOR_MIN_LINES, GATE_AUTHOR_HELD_FLOOR, gateAuthorPromotion, gateAuthorAuthorityAcrossCampaigns,
  stagingDirFor, heldoutDirFor, prepareStaging, authoringBrief, authoringSidecar, checkCommand,
  checkStaged, authorCampaign, gateProposal, sealGate, draftToSpec, authorMain, previousLineId,
} from '../cynco-gate-author.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { summarize } from '../cynco-gate-lines.mjs'
import { applyProposalDecision } from '../cynco-campaign.mjs'
import { GATE_AUTHOR_MIN_LINES as SV_MIN_LINES, GATE_AUTHOR_HELD_FLOOR as SV_HELD_FLOOR } from '../cynco-signal-validation.mjs'

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
  // the SIBLING form the sealed gates use — gate_c8.py resolves gate_c7.py the
  // same way, which is why the staging tree has to mirror the sealed one
  '    prior = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "c8", "gate_c8.py")',
  '    env = {k: v for k, v in os.environ.items() if k != "CYNCO_GATE_SKIP_PRIOR"}',
  '    r = subprocess.run([sys.executable, prior], cwd=REPO, env=env, capture_output=True, text=True, timeout=3600)',
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

const gateLog = (statuses, terminator, echo = []) =>
  IDS.map(i => `${i}: ${statuses[i] ?? 'FAIL'} detail`).join('\n') + '\n' + echo.map(l => `  ${l}\n`).join('') + `${terminator}\n`
// A real BASE run echoes the prior chain before printing its own terminator —
// the C9.9 block prints `  [c8] …` lines. Everything that reads this output has
// to tell the two apart.
const PRIOR_ECHO = ['[c8] C8.1a.tiers-pressable: FAIL tiers drawn+pressed=[]', '[c8] GATE: MISS (4 fails)']
const BASE_LOG = gateLog({}, 'GATE: MISS (9 fails)', PRIOR_ECHO)
const PERTURB_LOG = gateLog({ 'C9.1a.modes-listed': 'PASS' }, 'GATE: MISS (8 fails)')
const POSITIVE_LOG = gateLog(Object.fromEntries(IDS.map(i => [i, 'PASS'])), 'GATE: PASS')

const norm = (p) => String(p).replace(/\\/g, '/')

function makeIo({ home, files = {}, baseLog = BASE_LOG, perturbLog = PERTURB_LOG, positiveLog = POSITIVE_LOG, row = { missionId: 'c9-author-1', verified: true }, over = {} } = {}) {
  const disk = { ...files }
  const dispatched = [], logs = [], ran = [], copied = [], renamed = []
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
    // existsSync answers for directories too, and sealGate's reseal branch
    // turns on exactly that question.
    exists: (p) => { const k = norm(p); return k in disk || Object.keys(disk).some(x => x.startsWith(k + '/')) },
    readFile: (p) => { const k = norm(p); if (k in disk) return disk[k]; throw new Error(`ENOENT ${p}`) },
    writeFile: (p, s) => { disk[norm(p)] = s },
    copy: (src, dst) => { copied.push([norm(src), norm(dst)]); disk[norm(dst)] = io.readFile(src) },
    // One level of children, derived from the fake disk's keys, the way
    // readdirSync answers: names only, directories included, absent → [].
    listDir: (p) => {
      const pre = norm(p).replace(/\/$/, '') + '/'
      const names = new Set()
      for (const k of Object.keys(disk)) {
        if (!k.startsWith(pre) || k === pre) continue
        const rest = k.slice(pre.length).replace(/\/$/, '')
        if (rest) names.add(rest.split('/')[0])
      }
      return [...names]
    },
    rename: (src, dst) => {
      const pre = norm(src).replace(/\/$/, '')
      for (const k of Object.keys(disk)) {
        if (k !== pre && !k.startsWith(pre + '/')) continue
        disk[norm(dst) + k.slice(pre.length)] = disk[k]
        delete disk[k]
      }
      renamed.push([pre, norm(dst)])
    },
    removeDir: (p) => {
      const pre = norm(p).replace(/\/$/, '')
      for (const k of Object.keys(disk)) if (k === pre || k.startsWith(pre + '/')) delete disk[k]
    },
    remove: (p) => { delete disk[norm(p)] },
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
  return { io, disk, dispatched, logs, ran, copied, renamed }
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

/** A sealed tree with three finished campaigns and the debris a real one has. */
const SEALED_TREE = (home) => ({
  [`${home}/heldout/civkings-redesign/c6/gate_c6.py`]: '# gate_c6\n',
  [`${home}/heldout/civkings-redesign/c6/perturb_c6.py`]: '# perturb_c6\n',
  [`${home}/heldout/civkings-redesign/c6/positive_c6.py`]: '# positive_c6\n',
  [`${home}/heldout/civkings-redesign/c6/suite_baseline_36fddfd.txt`]: 'FAILED a\n',
  [`${home}/heldout/civkings-redesign/c7/gate_c7.py`]: '# gate_c7\n',
  [`${home}/heldout/civkings-redesign/c7/perturb_c7.py`]: '# perturb_c7\n',
  [`${home}/heldout/civkings-redesign/c8/gate_c8.py`]: '# gate_c8\n',
  [`${home}/heldout/civkings-redesign/c8/perturb_c8.py`]: '# perturb_c8\n',
  [`${home}/heldout/civkings-redesign/c8/suite_baseline_1d03308.txt`]: 'FAILED b\n',
  [`${home}/heldout/civkings-redesign/c8/__pycache__/gate_c8.cpython-312.pyc`]: 'binary',
})

describe('prepareStaging', () => {
  it('git-inits an absent staging dir, pins an identity, and archives the BASE', () => {
    const { io, ran } = makeIo({ home })
    const r = prepareStaging({ id: ID, base: LINE.base, repo: 'C:/Users/civer/civkings', io })
    expect(norm(r.stagingDir)).toBe(`${home}/authoring/c9`)
    expect(norm(r.baseDir)).toBe('C:/tmp/c9_author_base')
    expect(ran.some(k => k.startsWith('git init'))).toBe(true)
    expect(ran.some(k => /archive/.test(k) && k.includes(LINE.base))).toBe(true)
  })

  // A repo with no identity refuses every commit, and the mission is ORDERED
  // to commit after each cut. dispatch-mission.sh runs git in the same tree
  // under `set -e`, so this is fatal, not cosmetic.
  it('pins user.name and user.email on the staging repo', () => {
    const { io, ran } = makeIo({ home })
    prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(ran).toContain(`git -C ${home}/authoring/c9 config user.name cynco-author`)
    expect(ran).toContain(`git -C ${home}/authoring/c9 config user.email cynco@localhost`)
  })

  it('does not re-init a staging dir that already has a .git', () => {
    const { stagingDir, files } = staged(home)
    const { io, ran } = makeIo({ home, files })
    prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(norm(stagingDir)).toBe(`${home}/authoring/c9`)
    expect(ran.some(k => k.startsWith('git init'))).toBe(false)
  })

  // CRITICAL: a sealed gate resolves its prior gate as `../<prevId>/gate_*.py`.
  // Unless the staging tree has the same shape as the sealed tree, C<N>.9 is
  // red at BASE for a reason that has nothing to do with the game and green
  // the moment the triple moves — a calibration that measured the layout.
  it('mirrors every finished campaign as a sibling of the staging dir', () => {
    const { io, disk } = makeIo({ home, files: SEALED_TREE(home) })
    prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(disk[`${home}/authoring/c6/gate_c6.py`]).toBe('# gate_c6\n')
    expect(disk[`${home}/authoring/c6/perturb_c6.py`]).toBe('# perturb_c6\n')
    expect(disk[`${home}/authoring/c6/positive_c6.py`]).toBe('# positive_c6\n')
    expect(disk[`${home}/authoring/c7/gate_c7.py`]).toBe('# gate_c7\n')
    expect(disk[`${home}/authoring/c8/gate_c8.py`]).toBe('# gate_c8\n')
    expect(disk[`${home}/authoring/c8/perturb_c8.py`]).toBe('# perturb_c8\n')
  })

  it('mirrors instruments only — no suite baselines, no __pycache__', () => {
    const { io, disk } = makeIo({ home, files: SEALED_TREE(home) })
    const r = prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(r.mirrored.sort()).toEqual(['c6/gate_c6.py', 'c6/perturb_c6.py', 'c6/positive_c6.py',
      'c7/gate_c7.py', 'c7/perturb_c7.py', 'c8/gate_c8.py', 'c8/perturb_c8.py'])
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/authoring/`) && /suite_baseline/.test(k))).toBe(false)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/authoring/`) && /__pycache__|\.pyc$/.test(k))).toBe(false)
  })

  // The author's own directory is the one thing the mirror must not touch: it
  // holds the work in progress, and heldout/<id> may already hold last round's
  // seal of the same campaign.
  it('never mirrors over the campaign being authored', () => {
    const { stagingDir, files } = staged(home)
    const { io, disk } = makeIo({ home, files: { ...files, ...SEALED_TREE(home), [`${home}/heldout/civkings-redesign/c9/gate_c9.py`]: '# an older seal\n' } })
    prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(disk[`${norm(stagingDir)}/gate_c9.py`]).toBe(GATE_SRC)
  })

  it('mirrors nothing, and does not throw, when the sealed tree is empty', () => {
    const { io } = makeIo({ home })
    expect(prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io }).mirrored).toEqual([])
  })

  // A machine that died between the seal's copy and its rename leaves a
  // `<x>.sealing-<ts>` behind. It is a half-written seal, not a campaign.
  it('never mirrors a half-written seal', () => {
    const files = { ...SEALED_TREE(home), [`${home}/heldout/civkings-redesign/c8.sealing-20260923100000000/gate_c8.py`]: '# half-written\n' }
    const { io, disk } = makeIo({ home, files })
    const r = prepareStaging({ id: ID, base: LINE.base, repo: 'C:/r', io })
    expect(r.mirrored.some(m => m.includes('.sealing-'))).toBe(false)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/authoring/`) && k.includes('.sealing-'))).toBe(false)
    expect(disk[`${home}/authoring/c8/gate_c8.py`]).toBe('# gate_c8\n')
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

  // The regression line must be written the way the SEALED gates write it,
  // because the staging tree is mirrored to have the same shape. Anything
  // "beside my own file" calibrates one layout and runs in another.
  it('mandates the sibling form for the prior-gate path, with the chain re-armed', () => {
    const t = build()
    expect(t).toContain('os.path.join(os.path.dirname(os.path.abspath(__file__)),')
    expect(t).toContain('"..", "c8", "gate_c8.py")')
    expect(t).not.toMatch(/beside yours|falling back/)
    expect(t).toContain('{k: v for k, v in os.environ.items() if k != "CYNCO_GATE_SKIP_PRIOR"}')
    expect(t).toMatch(/layout is identical in the sealed tree/)
  })

  it('strips a sealed path out of the previous check output too', () => {
    const t = build({ previousCheck: `lint: no graded lines\nread ${home}/heldout/civkings-redesign/c8/gate_c8.py` })
    expect(t).not.toContain('heldout')
    expect(t).toContain('lint: no graded lines')
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
  // A key the author does not own is either a runner-owned field it tried to
  // set or a typo of one it meant to; both are silent in a plain spread.
  it('refuses draft fields the author does not own, naming them', () => {
    const d = { ...DRAFT(), budget: { waves: 99 }, marker: 'stage c9 complete' }
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS }))
      .toThrow(/does not own: budget, marker/)
  })
  it('refuses a gateId the gate does not grade', () => {
    const d = DRAFT(); d.work[0].gateIds = [...d.work[0].gateIds, 'C9.7.does-not-exist']
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS }))
      .toThrow(/does not grade: C9\.7\.does-not-exist/)
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
    // --check is three gate runs plus, once, the whole suite. The model's own
    // Bash cap (120 s) and the driver's check cap (600 s) would both kill the
    // command the mission is graded on.
    // and they are ONE number: the model runs the check itself and the driver
    // runs the same command to grade it.
    expect(d.env.CYNCO_BASH_TIMEOUT_MS).toBe('7200000')
    expect(d.env.CYNCO_CHECK_TIMEOUT_MS).toBe('7200000')
    expect(d.env.CYNCO_BASH_TIMEOUT_MS).toBe(d.env.CYNCO_CHECK_TIMEOUT_MS)
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
    const { io, disk, logs, copied, renamed } = makeIo({ home, files, ...over })
    const roadmap = ROADMAP(); roadmap.lines.find(l => l.id === 'c9').status = 'proposed'
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.authoring = { c9: { stagingDir, baseDir: 'C:/tmp/c9_author_base', missionId: 'c9-author-1', verified: true } }
    const r = await sealGate({ id: ID, state, roadmap, io })
    return { r, roadmap, state, disk, logs, copied, renamed, io }
  }

  it('copies the triple to heldout, writes a spec that loads, and marks the line sealed', async () => {
    const { r, roadmap, state, disk } = await setup()
    expect(r.ok).toBe(true)
    for (const f of ['gate_c9.py', 'perturb_c9.py', 'positive_c9.py']) {
      expect(disk[`${home}/heldout/civkings-redesign/c9/${f}`]).toBeTruthy()
    }
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe(GATE_SRC)
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

  // The triple lands in a sibling temp directory and is RENAMED into place, so
  // a copy that dies halfway leaves heldout/<id> absent rather than partial.
  it('stages the copy under <id>.sealing-<ts> and renames it into place', async () => {
    const { copied, renamed, disk } = await setup()
    expect(copied.every(([, dst]) => /\/c9\.sealing-\d+\//.test(dst))).toBe(true)
    expect(renamed).toHaveLength(1)
    expect(renamed[0][0]).toMatch(/\/c9\.sealing-\d+$/)
    expect(renamed[0][1]).toBe(`${home}/heldout/civkings-redesign/c9`)
    expect(Object.keys(disk).some(k => /\.sealing-/.test(k))).toBe(false)
  })

  it('writes the campaign-log entry with all three sha256s and the calibration tails', async () => {
    const { logs, r } = await setup()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/^## Campaign C9 — Ship shell \(authored by CynCo, sealed \d{4}-\d{2}-\d{2}, BASE e9366f3, gate_c9\.py sha256 [0-9a-f]{16}\)$/m)
    expect(logs[0]).toContain(LINE.bar)
    expect(logs[0]).toContain('c9-author-1')
    expect(logs[0]).toContain('C9.9')
    expect(logs[0]).toMatch(/gate_c9\.py [0-9a-f]{16}, perturb_c9\.py [0-9a-f]{16}, positive_c9\.py [0-9a-f]{16}/)
    for (const k of ['gateSha256', 'perturbSha256', 'positiveSha256']) expect(logs[0]).toContain(r[k])
    // the three calibration tails, each as the run actually printed it
    expect(logs[0]).toMatch(/BASE printed GATE: MISS \(9 fails\)/)
    expect(logs[0]).toMatch(/flips C9\.1a\.modes-listed/)
    expect(logs[0]).toMatch(/positive shim printed GATE: PASS/)
  })

  // The BASE tail carries the PRIOR campaign's terminator too, echoed by the
  // C9.9 block and printed BEFORE the gate's own. A first-match read of that
  // tail put "MISS (4 fails)" — C8's verdict — in C9's campaign-log entry.
  it('prints the gate\'s own terminator, not the prior chain\'s echo', async () => {
    const { logs } = await setup()
    expect(BASE_LOG).toContain('  [c8] GATE: MISS (4 fails)')
    expect(BASE_LOG.indexOf('[c8] GATE: MISS')).toBeLessThan(BASE_LOG.indexOf('GATE: MISS (9 fails)'))
    expect(logs[0]).toContain('BASE printed GATE: MISS (9 fails)')
    expect(logs[0]).not.toContain('4 fails')
  })

  it('refuses a draft whose brief-visible text names the sealed gate, writing nothing at all', async () => {
    const { r, disk, renamed } = await setup({}, { measures: 'every fact gate_c9.py grades is drawn' })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/gate_c9\.py/)
    expect('docs/civkings-redesign-briefs/c9.campaign.json' in disk).toBe(false)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/heldout/civkings-redesign/c9`))).toBe(false)
    expect(renamed).toEqual([])
  })

  // The fix that matters: a refused seal must leave the operator somewhere to
  // stand. Nothing under heldout, and the same triple seals on the next try
  // once the draft is corrected.
  it('a refusal leaves heldout absent and the next attempt succeeds', async () => {
    const { stagingDir, files } = staged(home)
    files[`${norm(stagingDir)}/${ID}.campaign.draft.json`] = JSON.stringify({ ...DRAFT(), measures: 'gate_c9.py grades it' }, null, 2)
    const { io, disk } = makeIo({ home, files })
    const roadmap = ROADMAP(); roadmap.lines.find(l => l.id === 'c9').status = 'proposed'
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.authoring = { c9: { stagingDir, baseDir: 'C:/tmp/c9_author_base', missionId: 'c9-author-1', verified: true } }

    const first = await sealGate({ id: ID, state, roadmap, io })
    expect(first.ok).toBe(false)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/heldout/civkings-redesign/c9`))).toBe(false)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
    expect(state.state.authoring.c9.sealedAt).toBeUndefined()

    // the author fixes the draft; nothing else changes
    io.writeFile(`${norm(stagingDir)}/${ID}.campaign.draft.json`, JSON.stringify(DRAFT(), null, 2))
    const second = await sealGate({ id: ID, state, roadmap, io })
    expect(second.problems).toEqual([])
    expect(second.ok).toBe(true)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe(GATE_SRC)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('sealed')
  })

  it('never overwrites a sealed gate with a different sha', async () => {
    const { r, disk } = await setup({}, {}, { [`${home}/heldout/civkings-redesign/c9/gate_c9.py`]: '# a human wrote this one\n' })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/already holds/)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe('# a human wrote this one\n')
  })

  // A reseal copies in place instead of renaming: the directory holds a suite
  // baseline the campaign measured, and a rename would carry it off.
  it('reseals the identical gate in place, keeping the suite baseline', async () => {
    const { r, disk, renamed } = await setup({}, {}, {
      [`${home}/heldout/civkings-redesign/c9/gate_c9.py`]: GATE_SRC,
      [`${home}/heldout/civkings-redesign/c9/suite_baseline_e9366f3.txt`]: 'FAILED standing\n',
    })
    expect(r.ok).toBe(true)
    expect(renamed).toEqual([])
    expect(disk[`${home}/heldout/civkings-redesign/c9/suite_baseline_e9366f3.txt`]).toBe('FAILED standing\n')
    expect(disk[`${home}/heldout/civkings-redesign/c9/positive_c9.py`]).toBe(POSITIVE_SRC)
  })

  it('refuses when the staged triple no longer passes the check', async () => {
    const { r, disk } = await setup({ baseLog: POSITIVE_LOG })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/BASE must MISS/)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/heldout/civkings-redesign/c9`))).toBe(false)
  })

  it('refuses a staged triple with a file missing', async () => {
    const { stagingDir, files } = staged(home)
    delete files[`${norm(stagingDir)}/perturb_c9.py`]
    const { io, disk } = makeIo({ home, files })
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.authoring = { c9: { stagingDir, baseDir: 'C:/tmp/c9_author_base', missionId: 'c9-author-1', verified: true } }
    const r = await sealGate({ id: ID, state, roadmap: ROADMAP(), io })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/missing: perturb_c9\.py is not in the staging dir/)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/heldout/civkings-redesign/c9`))).toBe(false)
  })

  it('refuses when nothing was authored for the id', async () => {
    const { io } = makeIo({ home })
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await sealGate({ id: ID, state, roadmap: ROADMAP(), io })
    expect(r.ok).toBe(false)
    expect(r.problems.join('\n')).toMatch(/nothing staged/)
  })

  // The trial spec is scaffolding. Left beside the BASE archive it is a file
  // that looks like a campaign spec and is not one.
  it('removes the trial spec on success and on a refusal', async () => {
    const ok = await setup()
    expect(ok.r.ok).toBe(true)
    expect('C:/tmp/c9_seal_check.campaign.json' in ok.disk).toBe(false)
    const refused = await setup({ over: { loadSpec: () => { throw new Error('keepGreen contains a wildcard') } } })
    expect(refused.r.ok).toBe(false)
    expect(refused.r.problems.join('\n')).toMatch(/would not load: keepGreen contains a wildcard/)
    expect('C:/tmp/c9_seal_check.campaign.json' in refused.disk).toBe(false)
  })

  it('cleans the sealing temp dir when the copy dies halfway', async () => {
    const { stagingDir, files } = staged(home)
    const { io, disk } = makeIo({ home, files })
    const realCopy = io.copy
    io.copy = (src, dst) => { if (/positive_c9\.py$/.test(norm(dst))) throw new Error('ENOSPC'); return realCopy(src, dst) }
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.authoring = { c9: { stagingDir, baseDir: 'C:/tmp/c9_author_base', missionId: 'c9-author-1', verified: true } }
    await expect(sealGate({ id: ID, state, roadmap: ROADMAP(), io })).rejects.toThrow(/ENOSPC/)
    expect(Object.keys(disk).some(k => /\.sealing-/.test(k))).toBe(false)
    expect(Object.keys(disk).some(k => k.startsWith(`${home}/heldout/civkings-redesign/c9/`))).toBe(false)
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

// ── The seat's authority is read across every campaign, not one state file ──

describe('gateAuthorAuthorityAcrossCampaigns', () => {
  const campaigns = (byId) => {
    const dir = mkdtempSync(join(tmpdir(), 'seat-'))
    for (const [id, state] of Object.entries(byId)) {
      mkdirSync(join(dir, id), { recursive: true })
      writeFileSync(join(dir, id, 'state.json'), JSON.stringify({ id, ...state }, null, 2))
    }
    return dir
  }

  it('is the highest value approved in any campaign', () => {
    expect(gateAuthorAuthorityAcrossCampaigns(campaigns({ c7: { gateAuthorAuthority: 0 }, c8: { gateAuthorAuthority: 0.5 }, c9: {} }))).toBe(0.5)
  })

  it('is 0 when no campaign has earned anything', () => {
    expect(gateAuthorAuthorityAcrossCampaigns(campaigns({ c8: { gateAuthorAuthority: 0 }, c9: {} }))).toBe(0)
  })

  it('is 0 for a campaigns dir that does not exist', () => {
    expect(gateAuthorAuthorityAcrossCampaigns(join(tmpdir(), 'no-such-campaigns-dir-' + Date.now()))).toBe(0)
  })

  it('ignores a state file whose authority is not a finite number', () => {
    expect(gateAuthorAuthorityAcrossCampaigns(campaigns({ c8: { gateAuthorAuthority: 'lots' }, c9: { gateAuthorAuthority: null } }))).toBe(0)
  })
})

describe('--author at earned authority, end to end', () => {
  const runAuthor = async (seatState) => {
    const campaignsDir = mkdtempSync(join(tmpdir(), 'seat-e2e-'))
    for (const [id, state] of Object.entries(seatState)) {
      mkdirSync(join(campaignsDir, id), { recursive: true })
      writeFileSync(join(campaignsDir, id, 'state.json'), JSON.stringify({ id, ...state }, null, 2))
    }
    const { files } = staged(home)
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const { io, disk } = makeIo({ home, files, over: {
      loadRoadmap: () => ROADMAP(),
      stateFor: () => state,
      applyProposalDecision,
      // Exactly what the runner's authorIo hands over.
      seatAuthority: () => gateAuthorAuthorityAcrossCampaigns(campaignsDir),
    } })
    const code = await authorMain(['--author', ID], io)
    return { code, state, disk }
  }

  it('c8 approved at 0.5 and c9 fresh: --author c9 seals c9', async () => {
    const { code, state, disk } = await runAuthor({ c8: { gateAuthorAuthority: 0.5 }, c9: {} })
    expect(code).toBe(0)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe(GATE_SRC)
    expect(state.state.proposals.find(p => p.name === 'gate/c9')).toMatchObject({ status: 'approved', decidedBy: 'auto' })
  })

  it('nothing approved anywhere: --author c9 raises the proposal and seals nothing', async () => {
    const { code, state, disk } = await runAuthor({ c8: { gateAuthorAuthority: 0 }, c9: {} })
    expect(code).toBe(0)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBeUndefined()
    expect(state.state.proposals.find(p => p.name === 'gate/c9').status).toBe('pending')
  })
})

describe('constants', () => {
  it('are the budget the spec set', () => {
    expect(AUTHOR_TIMEOUT_S).toBe(14400)
    expect(AUTHOR_ITERATIONS).toBe(1200)
    expect(GATE_AUTHOR_MAX_AUTHORITY).toBe(0.5)
    expect(AUTHOR_INVARIANTS).toEqual({ editGapCap: 40, commitGapCap: 150, revertBan: true, codeIndexFirst: true })
  })

  it('the promotion bar is the one the gate-line table prints', () => {
    expect(GATE_AUTHOR_MIN_LINES).toBe(30)
    expect(GATE_AUTHOR_HELD_FLOOR).toBe(0.8)
    // One definition, two readers: the table and the promotion must never be
    // able to disagree about what the bar is.
    expect(GATE_AUTHOR_MIN_LINES).toBe(SV_MIN_LINES)
    expect(GATE_AUTHOR_HELD_FLOOR).toBe(SV_HELD_FLOOR)
  })
})

// ── Ruling 11: the promotion the evidence earns ─────────────────────────────

describe('gateAuthorPromotion', () => {
  const rowsFor = (author, held, n) => [
    ...Array.from({ length: held }, (_, i) => ({ author, outcome: 'held', lineId: `${author}-h${i}` })),
    ...Array.from({ length: n - held }, (_, i) => ({ author, outcome: 'resealed', lineId: `${author}-r${i}` })),
  ]
  const summaryOf = (cynco, human) => summarize([...rowsFor('cynco', ...cynco), ...rowsFor('human', ...human)])

  it('refuses below the minimum line count, however clean', () => {
    expect(gateAuthorPromotion(summaryOf([29, 29], [17, 17]), 0)).toBeNull()
  })

  it('proposes gate-author/gate at 0.5 with the evidence attached', () => {
    const summary = summaryOf([30, 30], [17, 17])
    const p = gateAuthorPromotion(summary, 0)
    expect(p).toMatchObject({ type: 'Parameter', name: 'gate-author/gate', newValue: 0.5, bounds: { min: 0, max: 0.5 }, status: 'pending' })
    expect(p.evidence).toEqual({ n: 30, held: 30, rate: 1, ci: summary.byAuthor.cynco.ci, p: summary.fisher.p, humanRate: 1, table: [[30, 0], [17, 0]] })
  })

  it('refuses when the Wilson lower bound is under the floor', () => {
    // 22/30 is a 73 % point estimate with a lower bound of 0.56 — a rate that
    // reads fine and an interval that does not clear the bar.
    expect(gateAuthorPromotion(summaryOf([22, 30], [17, 17]), 0)).toBeNull()
    // The brief's own case: 24/30 against a human 50/50.
    expect(gateAuthorPromotion(summaryOf([24, 30], [50, 50]), 0)).toBeNull()
  })

  it('refuses a seat that clears the floor but reads significantly worse than the human', () => {
    // 92/100 clears both bars on its own (lower bound 0.85) — and is still
    // worse than 200/200 at p < 0.05, so it has not earned the human's seat.
    const summary = summaryOf([92, 100], [200, 200])
    expect(summary.byAuthor.cynco.ci[0]).toBeGreaterThanOrEqual(0.8)
    expect(summary.fisher.p).toBeLessThan(0.05)
    expect(gateAuthorPromotion(summary, 0)).toBeNull()
    expect(gateAuthorPromotion(summary, 0, 0.05, { explain: true }).why).toMatch(/worse than the human/)
  })

  it('refuses once the authority is already at its ceiling', () => {
    expect(gateAuthorPromotion(summaryOf([30, 30], [17, 17]), GATE_AUTHOR_MAX_AUTHORITY)).toBeNull()
  })

  it('a better-than-human seat at p < 0.05 is promoted, not refused', () => {
    // The Fisher clause is one-directional on purpose: significance alone must
    // not refuse the seat it is meant to measure.
    const summary = summaryOf([100, 100], [30, 40])
    expect(summary.fisher.p).toBeLessThan(0.05)
    expect(gateAuthorPromotion(summary, 0)).not.toBeNull()
  })

  it('explain hands back the proposal and the reason, keeping the plain call proposal-or-null', () => {
    const ok = gateAuthorPromotion(summaryOf([30, 30], [17, 17]), 0, 0.05, { explain: true })
    expect(ok.proposal.name).toBe('gate-author/gate')
    expect(ok.why).toBeNull()
    const no = gateAuthorPromotion(summaryOf([29, 29], [17, 17]), 0, 0.05, { explain: true })
    expect(no.proposal).toBeNull()
    expect(no.why).toMatch(/29/)
  })

  it('a summary that never arrived is no promotion, not a throw', () => {
    expect(gateAuthorPromotion(null, 0)).toBeNull()
  })
})

// ── The auto-approve branch: what earned authority actually buys ────────────

describe('authorCampaign at earned authority', () => {
  const runAt = async (authority, over = {}) => {
    const { files } = staged(home)
    const notified = []
    const { io, disk, logs } = makeIo({ home, files, over: { notify: async (m) => { notified.push(m); return true }, applyProposalDecision, ...over } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.gateAuthorAuthority = authority
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    return { r, roadmap, state, disk, logs, notified }
  }

  it('at 0.5 the seat seals its own gate and records the decision as auto', async () => {
    const { r, roadmap, state, disk, notified } = await runAt(GATE_AUTHOR_MAX_AUTHORITY)
    expect(r.ok).toBe(true)
    expect(r.sealed.ok).toBe(true)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe(GATE_SRC)
    expect(disk['docs/civkings-redesign-briefs/c9.campaign.json']).toBeTruthy()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('sealed')
    const p = state.state.proposals.find(x => x.name === 'gate/c9')
    expect(p.status).toBe('approved')
    expect(p.decidedBy).toBe('auto')
    expect(p.decidedAt).toBeTruthy()
    expect(notified.join('\n')).toMatch(/gate\/c9/)
  })

  it('at 0 the proposal stays pending and nothing is sealed', async () => {
    const { r, roadmap, state, disk } = await runAt(0)
    expect(r.ok).toBe(true)
    expect(r.sealed).toBeNull()
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBeUndefined()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
    expect(state.state.proposals.find(x => x.name === 'gate/c9').status).toBe('pending')
  })

  // A seal that refuses is not a decision. The proposal has to stay pending or
  // the operator has nothing left to approve once the draft is fixed — the
  // dead end `--approve-proposal gate/<id>` was rebuilt to avoid.
  it('a refused seal at 0.5 leaves the proposal pending and says why', async () => {
    const { r, roadmap, state } = await runAt(GATE_AUTHOR_MAX_AUTHORITY, {
      loadSpec: () => { throw new Error('budget.waves must be a positive integer') },
    })
    expect(r.sealed.ok).toBe(false)
    expect(r.sealed.problems.length).toBeGreaterThan(0)
    expect(state.state.proposals.find(x => x.name === 'gate/c9').status).toBe('pending')
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
  })

  // The two ends of the ladder live in different state files: the promotion is
  // approved into the state of the campaign that GATHERED the evidence, and the
  // auto-approve branch runs inside the campaign being AUTHORED, which is
  // always fresh. Reading only the local state, an earned 0.5 never arrives.
  it('seals on the SEAT\'s authority even when this campaign\'s own state says 0', async () => {
    const { r, state, disk } = await runAt(0, { seatAuthority: () => GATE_AUTHOR_MAX_AUTHORITY })
    expect(state.state.gateAuthorAuthority).toBe(0)
    expect(r.sealed.ok).toBe(true)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBe(GATE_SRC)
    expect(state.state.proposals.find(x => x.name === 'gate/c9').decidedBy).toBe('auto')
  })

  it('a seat that has earned nothing anywhere leaves the proposal pending', async () => {
    const { r, state } = await runAt(0, { seatAuthority: () => 0 })
    expect(r.sealed).toBeNull()
    expect(state.state.proposals.find(x => x.name === 'gate/c9').status).toBe('pending')
  })

  // A direct `bun scripts/cynco-gate-author.mjs --author` has no runner behind
  // it and so no decision writer. Sealing first and discovering that second
  // would leave a gate in the sealed tree against a proposal still marked
  // pending — a seal nobody can audit and nobody can re-approve.
  it('refuses BEFORE sealing when the runner supplied no decision writer', async () => {
    const { files } = staged(home)
    const { io, disk } = makeIo({ home, files, over: { seatAuthority: () => GATE_AUTHOR_MAX_AUTHORITY, applyProposalDecision: undefined } })
    delete io.applyProposalDecision
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.sealed.ok).toBe(false)
    expect(r.sealed.problems[0]).toMatch(/applyProposalDecision was not supplied/)
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBeUndefined()
    expect(disk['docs/civkings-redesign-briefs/c9.campaign.json']).toBeUndefined()
    expect(state.state.proposals.find(x => x.name === 'gate/c9').status).toBe('pending')
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
  })

  it('seals nothing when there was no proposal to seal', async () => {
    const { files } = staged(home)
    const { io, disk } = makeIo({ home, files, baseLog: POSITIVE_LOG, over: { applyProposalDecision } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.gateAuthorAuthority = GATE_AUTHOR_MAX_AUTHORITY
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.proposal).toBeNull()
    expect(r.sealed).toBeNull()
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBeUndefined()
  })
})
