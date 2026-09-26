import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { loadCampaignSpec } from '../cynco-campaign-spec.mjs'
import {
  AUTHOR_TIMEOUT_S, AUTHOR_ITERATIONS, AUTHOR_INVARIANTS, WORKER_INVARIANTS, GATE_AUTHOR_MAX_AUTHORITY,
  GATE_AUTHOR_MIN_LINES, GATE_AUTHOR_HELD_FLOOR, gateAuthorPromotion, gateAuthorAuthorityAcrossCampaigns,
  stagingDirFor, heldoutDirFor, prepareStaging, authoringBrief, authoringSidecar, checkCommand,
  checkStaged, authorCampaign, gateProposal, sealGate, draftToSpec, authorMain, previousLineId,
  livePreviousCheck, positiveLeavesFailing, checkStagedViaSubprocess, restoreUncommittedWork, refreshedLastCheck,
  readPackageMap, packageMapText, AUTHOR_RESUME_TIMEOUT_S, authorTimeoutFor,
  CHECK_JSON_MARKER, SELF_SCRIPT, CHECK_SUBPROCESS_TIMEOUT_MS,
  checkRecord, staticRelativeImports, harnessClosure, harnessFileKey, harnessFingerprint, harnessDirtyFiles,
} from '../cynco-gate-author.mjs'
import { CampaignState } from '../cynco-campaign-state.mjs'
import { summarize } from '../cynco-gate-lines.mjs'
import { applyProposalDecision } from '../cynco-campaign.mjs'
import { readSeats, writeSeats } from '../cynco-proposals.mjs'
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

// F155: the runner's authoritative re-check is a SUBPROCESS now, so the fake io
// has to answer `bun <script> --check <staging> <base>`. `check` is what that
// subprocess reports; `checkStaged` itself is still driven directly, against
// `baseLog`/`perturbLog`/`positiveLog`, in its own describe block above.
const checkJson = (over = {}) => CHECK_JSON_MARKER + JSON.stringify({
  ok: true, problems: [], lineIds: IDS,
  tails: { base: BASE_LOG, perturb: PERTURB_LOG, positive: POSITIVE_LOG },
  ...over,
})

function makeIo({ home, files = {}, baseLog = BASE_LOG, perturbLog = PERTURB_LOG, positiveLog = POSITIVE_LOG, row = { missionId: 'c9-author-1', verified: true }, check = {}, checkOut = null, over = {} } = {}) {
  const disk = { ...files }
  const dispatched = [], logs = [], ran = [], copied = [], renamed = []
  const io = {
    mkdir: (p) => { disk[norm(p) + '/'] = '' },
    run: (cmd, args, opts) => {
      const k = [cmd, ...args].join(' ')
      ran.push(k)
      if (cmd === 'bun' && args.includes('--check')) {
        const out = checkOut ?? checkJson(check)
        const ok = checkOut ? !/REFUSED/.test(out) : (check.ok ?? true)
        return { status: ok ? 0 : 1, stdout: out, stderr: '', elapsedMs: 1, timedOut: false, fault: null }
      }
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
  it('names its script by absolute path and quotes both paths in the check command', () => {
    // F153: the brief tells the author to run this from the staging dir and the
    // driver runs it in the mission cwd — neither has a scripts/ beside it, so a
    // relative script path made the acceptance test unrunnable.
    const self = fileURLToPath(new URL('../cynco-gate-author.mjs', import.meta.url)).replace(/\\/g, '/')
    expect(isAbsolute(self)).toBe(true)
    expect(checkCommand('C:/a b/c9', 'C:/tmp/c9_author_base'))
      .toBe(`bun ${JSON.stringify(self)} --check "C:/a b/c9" "C:/tmp/c9_author_base"`)
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

  it('tells a resume the list is the PREVIOUS run\'s and to re-run the check', () => {
    const resumed = build({ previousCheck: 'lint: no graded lines' })
    expect(resumed).toContain('from the PREVIOUS run')
    expect(resumed).toContain('it works from any directory')
  })
})

/**
 * F154's second half. A stored check is as old as the run that produced it, and
 * a stopped run leaves the run-before-last's reading in state: attempt 3 of the
 * live C9 authoring was handed attempt 1's four `missing:` lines, one of them
 * naming a gate_c9.py that by then existed and was 17 KB, under the order "Fix
 * these before anything else".
 */
describe('livePreviousCheck', () => {
  const io = (present) => ({ exists: (p) => present.includes(basename(String(p).replace(/\\/g, '/'))) })
  const MISSING = (f) => `missing: ${f} was never written into the staging dir`

  it('drops a missing-file problem for a file that is now on disk', () => {
    const output = [MISSING('gate_c9.py'), MISSING('perturb_c9.py')].join('\n')
    expect(livePreviousCheck({ stagingDir: 'C:/s/c9', lastCheck: { output }, io: io(['gate_c9.py']) }))
      .toBe(MISSING('perturb_c9.py'))
  })

  it('carries no previous check at all once every missing file exists', () => {
    const output = [MISSING('gate_c9.py'), MISSING('perturb_c9.py')].join('\n')
    expect(livePreviousCheck({ stagingDir: 'C:/s/c9', lastCheck: { output },
      io: io(['gate_c9.py', 'perturb_c9.py']) })).toBeNull()
  })

  // A gate that dies at import writes its traceback to stderr, and a resume told
  // "BASE run printed 1 error line(s)" with no traceback is being asked to guess.
  it('shows the BASE and cheat-stub tails when they carry an error line', () => {
    const boom = 'Traceback (most recent call last):\nNameError: name _press is not defined\n'
    const t = livePreviousCheck({ stagingDir: 'C:/s/c9', io: io([]), lastCheck: {
      output: 'BASE run printed 2 error line(s): Traceback (most recent call last):',
      tails: { base: boom, perturb: `${gateLog({}, 'GATE: MISS (9 fails)')}`, positive: null },
    } })
    expect(t).toContain('gate-at-BASE output (tail):')
    expect(t).toContain('NameError: name _press is not defined')
    // The cheat stub ran cleanly, so its tail is noise here and is left out.
    expect(t).not.toContain('cheat stub output (tail):')
  })

  it('keeps every problem that is not a presence claim', () => {
    const output = ['lint: C9.4 has no detail', MISSING('positive_c9.py'), 'base: GATE: PASS at BASE'].join('\n')
    expect(livePreviousCheck({ stagingDir: 'C:/s/c9', lastCheck: { output }, io: io(['positive_c9.py']) }))
      .toBe('lint: C9.4 has no detail\nbase: GATE: PASS at BASE')
  })

  // Phase 4 residual: a located problem carries its FILE:LINE into the brief.
  it('prints `  at FILE:LINE` under each problem the check located, and nothing under the rest', () => {
    const located = 'lint: duplicate gate line id C9.2 — two facts graded under one id hide one of them (gate_c9.py:42)'
    const output = [located, 'BASE must MISS the gate; terminator was PASS (gate_c9.py)'].join('\n')
    const t = livePreviousCheck({ stagingDir: 'C:/s/c9', io: io([]), lastCheck: {
      output, problemAt: [{ file: 'gate_c9.py', line: 42, problem: located }, { file: 'x.py', line: 'NaN', problem: 'junk' }],
    } })
    expect(t).toBe(`${located}\n  at gate_c9.py:42\nBASE must MISS the gate; terminator was PASS (gate_c9.py)`)
  })

  it('checkRecord keeps the located problems as `problemAt`, beside its timestamp', () => {
    const problem = 'lint: line id "C8.1" is not a C9.<n> id (gate_c9.py:7)'
    const rec = checkRecord({ ok: false, problems: [problem], at: [{ file: 'gate_c9.py', line: 7, problem }], lineIds: ['C8.1'] }, { now: () => 'T' })
    expect(rec.at).toBe('T')
    expect(rec.problemAt).toEqual([{ file: 'gate_c9.py', line: 7, problem }])
    expect(checkRecord({ ok: true, problems: [], lineIds: [] }, { now: () => 'T' }).problemAt).toEqual([])
  })

  it('is null for no stored check and for an empty one', () => {
    expect(livePreviousCheck({ stagingDir: 'C:/s/c9', lastCheck: undefined, io: io([]) })).toBeNull()
    expect(livePreviousCheck({ stagingDir: 'C:/s/c9', lastCheck: { output: '  \n ' }, io: io([]) })).toBeNull()
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
  it('carries the lint\'s located problems as `at`, and the calibration problem names its file', async () => {
    const { stagingDir, files } = staged(home)
    files[`${norm(stagingDir)}/gate_c9.py`] = GATE_SRC.replace('import os, sys, subprocess, runpy', 'import os, sys, subprocess, runpy, socket')
    const { io } = makeIo({ home, files, baseLog: POSITIVE_LOG })
    const r = await checkStaged({ id: ID, stagingDir, baseDir: 'C:/tmp/c9_author_base', io })
    const net = r.problems.find(p => /imports socket/.test(p))
    expect(net.endsWith(' (gate_c9.py:2)')).toBe(true)
    expect(r.at).toEqual([{ file: 'gate_c9.py', line: 2, problem: net }])
    expect(r.problems.find(p => /BASE must MISS/.test(p))).toMatch(/ \(gate_c9\.py\)$/)
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
  // Review I1: the sealed spec is the WORKER campaign's; the authoring
  // mission's tripled edit gap must never leak into it.
  it('writes the worker invariants (c8\'s measured values), never the authoring mission\'s cap', () => {
    const spec = draftToSpec({ id: ID, draft: DRAFT(), line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })
    expect(spec.invariants).toEqual(WORKER_INVARIANTS)
    expect(spec.invariants.editGapCap).not.toBe(AUTHOR_INVARIANTS.editGapCap)
    const c8 = JSON.parse(readFileSync(fileURLToPath(new URL('../../docs/civkings-redesign-briefs/c8.campaign.json', import.meta.url)), 'utf8'))
    expect(WORKER_INVARIANTS).toEqual(c8.invariants)
    // a copy, not the constant itself: a later edit of the spec object must not rewrite the runner's value
    expect(spec.invariants).not.toBe(WORKER_INVARIANTS)
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
  /**
   * A draft's gateId is the SHORT id (`C9.1a`); a lint id is the full one
   * (`C9.1a.resolution-list`). Matched exactly, as this did, EVERY draft any author
   * could write would throw at seal time — and nothing caught it because the seal
   * had never been reached. The prefix rule is the one `parsePerturbHeader` already
   * uses for EXPECT-FLIP / MUST-FAIL, so a draft, a stub header and a gate now name
   * lines the same way.
   */
  it('accepts short gateIds against full lint ids, by the perturb header\'s prefix rule', () => {
    const shortIds = IDS.filter(x => x !== 'C9.9').map(x => x.split('.').slice(0, 2).join('.'))
    expect(shortIds[0]).not.toBe(IDS[0])       // genuinely shorter than the lint id
    const d = DRAFT()
    d.work = [{ id: 'w1', title: 'all of it', gateIds: shortIds, text: 'do it' }]
    const spec = draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS })
    expect(spec.work[0].gateIds).toEqual(shortIds)
  })

  it('still refuses a phantom short id that prefixes nothing the gate grades', () => {
    const d = DRAFT()
    d.work = [{ id: 'w1', title: 'all of it', gateIds: [...IDS.filter(x => x !== 'C9.9').map(x => x.split('.').slice(0, 2).join('.')), 'C9.4b'], text: 'x' }]
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS }))
      .toThrow(/does not grade: C9\.4b/)
  })

  // The prefix rule must not become a way to cover everything with one token:
  // `C9` would prefix every line, so a short id has to be a real id boundary.
  it('a short id covers only the lines it actually prefixes', () => {
    const d = DRAFT()
    d.work = [{ id: 'w1', title: 'partial', gateIds: ['C9.1a'], text: 'x' }]
    expect(() => draftToSpec({ id: ID, draft: d, line: LINE, paths: paths(home), authorMissionId: null, lineIds: IDS }))
      .toThrow(/do not cover/)
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
    const FAILED = { ok: false, problems: ['BASE must MISS the gate; terminator was PASS'] }
    const { r, roadmap, state } = await runIt({ check: FAILED })
    expect(r.ok).toBe(false)
    expect(r.proposal).toBeNull()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
    expect(state.state.authoring.c9.lastCheck.problems.join('\n')).toMatch(/BASE must MISS/)
    expect(state.state.proposals.some(p => p.name === 'gate/c9')).toBe(false)
  })

  // F155: the re-check is a fresh `bun … --check` process, because the runner's
  // own process has been idle for four hours and bun's spawnSync would carry a
  // stale deadline into its first gate run.
  it('re-checks as a subprocess, naming the script by absolute path, and reads the verdict from exit code + stdout', async () => {
    const { io, disk } = makeIo({ home, files: staged(home).files })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const spawned = []
    const inner = io.run
    io.run = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return inner(cmd, args, opts) }
    await authorCampaign({ id: ID, roadmap, state, io })
    const call = spawned.find(s => s.cmd === 'bun' && s.args.includes('--check'))
    expect(call).toBeTruthy()
    expect(call.args).toEqual([SELF_SCRIPT, '--check', `${home}/authoring/c9`, 'C:/tmp/c9_author_base', '--json'])
    expect(call.opts.timeoutMs).toBe(CHECK_SUBPROCESS_TIMEOUT_MS)
    // And it is the check the RUNNER believes: the proposal's line count is the
    // subprocess's, not anything computed in this process.
    expect(state.state.authoring.c9.lastCheck.lineCount).toBe(IDS.length)
    expect(disk[`${home}/authoring/c9/brief-1.txt`]).toBeTruthy()
  })

  it('treats a subprocess that printed no verdict as a refusal, carrying its output', async () => {
    const { r, state } = await runIt({ checkOut: '[check] c9: REFUSED — the world ended\n' })
    expect(r.ok).toBe(false)
    expect(state.state.authoring.c9.lastCheck.problems.join('\n')).toMatch(/without a \[check-json\] verdict/)
    expect(state.state.authoring.c9.lastCheck.problems.join('\n')).toMatch(/the world ended/)
  })

  it('names a re-check subprocess that could not run a harness fault, not a bad triple', async () => {
    const { files } = staged(home)
    const { io } = makeIo({ home, files })
    const inner = io.run
    io.run = (cmd, args, opts) => cmd === 'bun' && args.includes('--check')
      ? { status: null, stdout: '', stderr: '', elapsedMs: 6, timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 6 } }
      : inner(cmd, args, opts)
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.ok).toBe(false)
    expect(r.check.problems.join('\n')).toMatch(/harness fault: the re-check subprocess did not run \(code ETIMEDOUT/)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
  })

  // Review I4: the fingerprint is taken at dispatch and stored; a closure that
  // moves during the mission refuses the proposal as a fault.
  it('fingerprints the harness at dispatch and refuses the proposal when it moved during the mission', async () => {
    const A = { sha256: 'aaa', files: { 'cynco-gate-author.mjs': '1', 'cynco-campaign-calibrate.mjs': '2' } }
    const B = { sha256: 'bbb', files: { 'cynco-gate-author.mjs': '1', 'cynco-campaign-calibrate.mjs': 'EDITED BY THE MISSION' } }
    let current = A
    const { io, dispatched } = makeIo({ home, files: staged(home).files, over: {
      harnessHash: () => current,
      dispatch: async (a) => { dispatched.push(a); current = B; return { driverLog: a.env.DRIVER_LOG } },
    } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(dispatched).toHaveLength(1)
    const a = state.state.authoring.c9
    expect(a.harnessSha256).toBe('aaa')
    expect(a.harnessFiles).toEqual(A.files)
    expect(r.ok).toBe(false)
    expect(r.proposal).toBeNull()
    expect(r.kind).toBe('fault')
    expect(r.why).toMatch(/NOT GRADED — harness dirty: cynco-campaign-calibrate\.mjs/)
    expect(a.lastCheck).toMatchObject({ kind: 'fault', ok: false, harnessDirty: true, harnessDirtyFiles: ['cynco-campaign-calibrate.mjs'] })
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
    expect(state.state.proposals?.some(p => p.name === 'gate/c9') ?? false).toBe(false)
  })

  it('does not take the propose-from-staged shortcut when the harness moved since the last dispatch', async () => {
    const A = { sha256: 'aaa', files: { 'cynco-gate-lint.mjs': '1' } }
    const B = { sha256: 'bbb', files: { 'cynco-gate-lint.mjs': '2' } }
    let current = A
    const { io, dispatched } = makeIo({ home, files: staged(home).files, over: { harnessHash: () => current } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })       // attempt 1: dispatched under A, proposes
    expect(dispatched).toHaveLength(1)
    roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
    current = B                                                  // the closure moves between attempts
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(err.mock.calls.some(c => /harness closure changed since attempt 1 was dispatched \(cynco-gate-lint\.mjs\)/.test(String(c[0])))).toBe(true)
    err.mockRestore()
    expect(r.dispatched).not.toBe(false)
    expect(dispatched).toHaveLength(2)                           // it dispatched instead of proposing from disk
    expect(state.state.authoring.c9.harnessSha256).toBe('bbb')   // under a fingerprint of its own
  })

  it('dispatches a resume on the two-hour budget, and says so in the brief', async () => {
    const { files } = staged(home)
    const { io, dispatched, disk } = makeIo({ home, files, check: { ok: false, problems: ['positive shim did not PASS (terminator null)'] } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(dispatched[0].timeoutS).toBe(AUTHOR_TIMEOUT_S)
    expect(dispatched[1].timeoutS).toBe(AUTHOR_RESUME_TIMEOUT_S)
    expect(disk[`${home}/authoring/c9/brief-1.txt`]).toContain('(4 hours, 1200 iterations.)')
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toContain('(2 hours, 1200 iterations.)')
  })

  it('resumes into the same staging dir with the previous check output in the brief', async () => {
    const { files } = staged(home)
    const { io, disk } = makeIo({ home, files, check: { ok: false, problems: ['BASE must MISS the gate; terminator was PASS'] } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toContain('PREVIOUS CHECK OUTPUT')
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toMatch(/BASE must MISS/)
    expect(state.state.authoring.c9.attempts).toBe(2)
  })

  // Phase 4 residual, end to end: the check subprocess's `at` → lastCheck.problemAt
  // → the resume brief's `  at FILE:LINE` under the problem.
  it('the resume brief prints FILE:LINE under a problem the check located', async () => {
    const { files } = staged(home)
    const problem = 'lint: duplicate gate line id C9.2a — two facts graded under one id hide one of them (gate_c9.py:12)'
    const { io, disk } = makeIo({ home, files, check: { ok: false, problems: [problem], at: [{ file: 'gate_c9.py', line: 12, problem }] } })
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap: ROADMAP(), state, io })
    expect(state.state.authoring.c9.lastCheck.problemAt).toEqual([{ file: 'gate_c9.py', line: 12, problem }])
    await authorCampaign({ id: ID, roadmap: ROADMAP(), state, io })
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toContain(`${problem}\n  at gate_c9.py:12`)
  })

  // E: the resume brief must carry the EVIDENCE, not only the verdict. Attempt 4
  // was told the positive shim "did not PASS" and spent 130 iterations working
  // out why by reading the harness.
  it('resumes with the positive shim tail and the ids it leaves failing', async () => {
    const { files } = staged(home)
    const shimTail = ['Traceback (most recent call last):', "ModuleNotFoundError: No module named 'gilded.ui.views'"].join('\n')
    const { io, disk } = makeIo({ home, files, check: {
      ok: false, problems: ['positive shim did not PASS (terminator null)'],
      tails: { base: BASE_LOG, perturb: PERTURB_LOG, positive: `${gateLog({}, 'GATE: MISS (9 fails)')}\n${shimTail}` },
    } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(state.state.authoring.c9.positiveLeavesFailing).toBeUndefined()
    expect(state.state.authoring.c9.lastCheck.positiveLeavesFailing).toEqual(IDS)
    await authorCampaign({ id: ID, roadmap, state, io })
    const brief = disk[`${home}/authoring/c9/brief-2.txt`]
    expect(brief).toContain('positive shim output (tail):')
    expect(brief).toContain("ModuleNotFoundError: No module named 'gilded.ui.views'")
    expect(brief).toContain(`the positive shim leaves these lines FAIL: ${IDS.join(' ')}`)
  })

  // The roadmap is authored in order: an earlier line still in flight means
  // this line's exemplar does not exist yet, so the jump is refused.
  it('refuses a line that jumps ahead of an earlier line still in flight', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files })
    const roadmap = ROADMAP(); roadmap.lines.find(l => l.id === 'c8').status = 'open'
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.ok).toBe(false)
    expect(r.why).toMatch(/c8 is still "open" — author the roadmap in order, c8 before c9/)
    expect(dispatched).toEqual([])
    // The refusal is total: no staging, and the line it refused stays open.
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('open')
  })

  // Review #6: a PROPOSED line is not sealed, so it is not in the heldout tree
  // the next line's C<N>.9 sibling would be mirrored from.
  it('refuses the next line while the one before it is only proposed', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files })
    const roadmap = ROADMAP()
    roadmap.lines.find(l => l.id === 'c9').status = 'proposed'
    roadmap.lines.push({ id: 'c10', name: 'Next', bar: 'b', base: 'abcdef1', status: 'open' })
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), 'c10')).load()
    const r = await authorCampaign({ id: 'c10', roadmap, state, io })
    expect(r.ok).toBe(false)
    expect(r.check).toBeNull()
    expect(r.why).toMatch(/c9 is still "proposed" — author the roadmap in order, c9 before c10/)
    expect(dispatched).toEqual([])
    expect(roadmap.lines.find(l => l.id === 'c10').status).toBe('open')
  })

  it('authors the first line still in flight without complaint', async () => {
    const { r, roadmap } = await runIt()
    expect(r.ok).toBe(true)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
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

  /**
   * CONTROLLER RULING: the verdict is the runner's own check, never `verified`.
   *
   * `verified` is the driver's advisory reading and it is STRUCTURALLY null for
   * every authoring mission that runs to its budget — the run cannot go quiet, so
   * the driver records null and warns that its gate and the mission are racing for
   * the same tree. Gating on it made a green bar unproposable by construction:
   * live attempt 7 passed the driver's own check (exit 0, 277 s, `GATE: PASS`) AND
   * the runner's re-check (ok, 11 graded lines), and printed "no proposal — the
   * mission produced no verified check result".
   */
  it('proposes on a passing triple even when verified is null', async () => {
    const { r, roadmap, state } = await runIt({ row: { missionId: 'c9-author-1', verified: null } })
    expect(state.state.authoring.c9.verified).toBeNull()
    expect(r.proposal).toMatchObject({ name: 'gate/c9', status: 'pending' })
    expect(r.proposal.evidence.verified).toBeNull()
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
  })

  // A missing row is worth saying and not worth refusing over: the triple on disk
  // is what is being graded, and the runner's check reads it directly.
  it('proposes on a passing triple with no ledger row, and says the row was missing', async () => {
    const { r, roadmap, state } = await runIt({ row: null })
    expect(r.proposal).toMatchObject({ name: 'gate/c9' })
    expect(r.proposal.evidence.missionId).toBeNull()
    expect(state.state.authoring.c9.fault).toMatch(/driver exited without a ledger row — the triple was graded from disk/)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
  })

  it('proposes nothing when the triple is refused, and calls it a refusal', async () => {
    const { r, roadmap, state } = await runIt({ check: { ok: false, problems: ['positive shim did not PASS (terminator null)'] } })
    expect(r.proposal).toBeNull()
    expect(r.kind).toBe('refused')
    expect(r.why).toMatch(/--check refused the staged triple \(1 problem\(s\)\)/)
    expect(state.state.authoring.c9.lastCheck.kind).toBe('refused')
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
  })

  // A fault means the instrument did not run, so the triple is UNGRADED — a
  // different thing from a triple that is not a bar, and a different next move.
  it('proposes nothing on a harness fault, and calls it a fault', async () => {
    const { files } = staged(home)
    const { io } = makeIo({ home, files })
    const inner = io.run
    io.run = (cmd, args, opts) => cmd === 'bun' && args.includes('--check')
      ? { status: null, stdout: '', stderr: '', elapsedMs: 6, timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 6 } }
      : inner(cmd, args, opts)
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.proposal).toBeNull()
    expect(r.kind).toBe('fault')
    expect(r.why).toMatch(/^NOT GRADED — harness fault: the re-check subprocess did not run/)
    expect(state.state.authoring.c9.lastCheck.kind).toBe('fault')
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('authoring')
  })

  /**
   * A resume whose staged triple already passes has nothing for a mission to do,
   * and four hours of GPU to prove it. The reading is the same subprocess check
   * `authorCampaign` takes after a dispatch, so the evidence is identical.
   */
  it('proposes straight from a passing staged triple, without dispatching', async () => {
    const { files } = staged(home)
    const { io, dispatched, disk } = makeIo({ home, files })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    // Attempt 1 dispatches and proposes; the line is then `proposed`, so put it
    // back to `authoring` to stand for "a resume the operator runs again".
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(dispatched).toHaveLength(1)
    roadmap.lines.find(l => l.id === 'c9').status = 'authoring'

    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.ok).toBe(true)
    expect(r.dispatched).toBe(false)
    expect(dispatched).toHaveLength(1)                        // no second mission
    expect(disk[`${home}/authoring/c9/brief-2.txt`]).toBeUndefined()   // and no second brief
    expect(r.proposal).toMatchObject({ name: 'gate/c9', status: 'pending' })
    expect(r.proposal.evidence.lineCount).toBe(IDS.length)
    expect(roadmap.lines.find(l => l.id === 'c9').status).toBe('proposed')
    expect(state.state.proposals.filter(p => p.name === 'gate/c9' && p.status === 'pending')).toHaveLength(1)
  })

  /**
   * A supervisor refusal changes what the next attempt IS, and the check cannot
   * overrule it. The C9 triple that drew the real note was mechanically clean —
   * BASE missed by absence, the stub's header was exact, the shim reached
   * GATE: PASS — and still did not measure the roadmap line.
   */
  describe('a supervisor refusal', () => {
    const NOTE = 'C:/tmp/note.txt'
    const NOTE_TEXT = 'gate C9.1b: _press must draw first.\npositive: satisfy the lines through the game\'s own seams only.'

    const withNote = () => {
      const { files } = staged(home)
      files[NOTE] = NOTE_TEXT
      return makeIo({ home, files })
    }

    it('carries the note into the brief, right after PREVIOUS CHECK OUTPUT', async () => {
      const { io, disk } = withNote()
      const roadmap = ROADMAP()
      const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
      await authorCampaign({ id: ID, roadmap, state, io })          // attempt 1 proposes
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      await authorCampaign({ id: ID, roadmap, state, io, notePath: NOTE })
      const brief = disk[`${home}/authoring/c9/brief-2.txt`]
      expect(brief).toContain('SUPERVISOR REVIEW — the seal was refused')
      expect(brief).toContain('gate C9.1b: _press must draw first.')
      // Against the HEADINGS: "DONE WHEN" also appears inside the previous-check
      // prose ("run the check yourself (DONE WHEN, below …)"), so a bare indexOf
      // finds that mention and not the section.
      expect(brief.indexOf('\nSUPERVISOR REVIEW')).toBeGreaterThan(brief.indexOf('\nPREVIOUS CHECK OUTPUT\n'))
      expect(brief.indexOf('\nSUPERVISOR REVIEW')).toBeLessThan(brief.indexOf('\nDONE WHEN\n'))
    })

    // The whole point: a green check is not an answer to the refusal.
    it('DISPATCHES even though the refreshed check passes, and proposes nothing', async () => {
      const { io, dispatched } = withNote()
      const roadmap = ROADMAP()
      const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
      await authorCampaign({ id: ID, roadmap, state, io })
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      const r = await authorCampaign({ id: ID, roadmap, state, io, notePath: NOTE })
      expect(dispatched).toHaveLength(2)
      expect(r.dispatched).not.toBe(false)
    })

    // A re-authoring of MEANING, not a shim fix: it gets the full four hours.
    it('gets the full budget, not the resume budget', async () => {
      const { io, dispatched } = withNote()
      const roadmap = ROADMAP()
      const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
      await authorCampaign({ id: ID, roadmap, state, io })
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      await authorCampaign({ id: ID, roadmap, state, io, notePath: NOTE })
      expect(dispatched[1].timeoutS).toBe(AUTHOR_TIMEOUT_S)
    })

    // The refusal does not expire because the operator typed a shorter command.
    it('remembers the note path, so the next resume without --note still carries it', async () => {
      const { io, disk } = withNote()
      const roadmap = ROADMAP()
      const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
      await authorCampaign({ id: ID, roadmap, state, io })
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      await authorCampaign({ id: ID, roadmap, state, io, notePath: NOTE })
      expect(state.state.authoring.c9.refusals).toHaveLength(1)
      expect(state.state.authoring.c9.refusals[0]).toMatchObject({ by: 'supervisor', notePath: NOTE })

      // Attempt 2's green check proposed the re-authored triple (correctly — the
      // supervisor reviews the NEW one), so reopen the line the way a second
      // rejection would before asking for attempt 3.
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      await authorCampaign({ id: ID, roadmap, state, io })   // no notePath this time
      expect(disk[`${home}/authoring/c9/brief-3.txt`]).toContain('gate C9.1b: _press must draw first.')
      // And it is not recorded twice for the same path.
      expect(state.state.authoring.c9.refusals).toHaveLength(1)
    })

    it('says so and carries on when the note cannot be read', async () => {
      const { files } = staged(home)
      const { io, disk, dispatched } = makeIo({ home, files })
      const roadmap = ROADMAP()
      const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
      await authorCampaign({ id: ID, roadmap, state, io })
      roadmap.lines.find(l => l.id === 'c9').status = 'authoring'
      const r = await authorCampaign({ id: ID, roadmap, state, io, notePath: 'C:/tmp/not-there.txt' })
      expect(disk[`${home}/authoring/c9/brief-2.txt`]).toBeUndefined()   // no brief: it proposed instead
      expect(r.proposal).toMatchObject({ name: 'gate/c9' })
      expect(dispatched).toHaveLength(1)
    })
  })

  it('still dispatches a resume whose staged triple is refused', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files, check: { ok: false, problems: ['positive shim did not PASS (terminator null)'] } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    await authorCampaign({ id: ID, roadmap, state, io })
    await authorCampaign({ id: ID, roadmap, state, io })
    expect(dispatched).toHaveLength(2)
  })
})

/**
 * The resume brief is built from a reading taken NOW. Attempt 5's brief was built
 * from attempt 4's stored verdict — eleven problems, nine of them F155's
 * inventions — under the order "Fix these before anything else".
 */
describe('refreshedLastCheck', () => {
  const STALE = { at: 'then', ok: false, problems: ['too few gate lines: 0 < 8', 'gate timed out after 7200000 ms at BASE'], lineCount: 0, output: 'stale' }
  const fake = ({ present = true, result = null } = {}) => ({
    exists: () => present,
    now: () => 'now',
    run: () => result ?? { status: 1, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: false, problems: ['positive shim did not PASS (terminator null)'], lineIds: IDS, tails: { base: 'b', perturb: 'p', positive: POSITIVE_LOG } }), stderr: '', fault: null, timedOut: false },
  })

  it('keeps the stored reading on a first attempt — there is nothing staged to read', async () => {
    const r = await refreshedLastCheck({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', prev: { attempts: 0, lastCheck: STALE }, io: fake() })
    expect(r).toBe(STALE)
  })

  it('keeps the stored reading when the four files are not all staged yet', async () => {
    const r = await refreshedLastCheck({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', prev: { attempts: 1, lastCheck: STALE }, io: fake({ present: false }) })
    expect(r).toBe(STALE)
  })

  it('replaces a stale verdict with a fresh one, tails and failing ids included', async () => {
    const r = await refreshedLastCheck({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', prev: { attempts: 1, lastCheck: STALE }, io: fake() })
    expect(r.at).toBe('now')
    expect(r.problems).toEqual(['positive shim did not PASS (terminator null)'])
    expect(r.problems.join('\n')).not.toMatch(/too few gate lines|timed out/)
    expect(r.lineCount).toBe(IDS.length)
    expect(r.tails.positive).toBe(POSITIVE_LOG)
    expect(r.positiveLeavesFailing).toEqual([])
  })

  // A harness fault is not a reason to tell the model nothing at all.
  it('falls back to the stored reading when the refresh itself could not run', async () => {
    const r = await refreshedLastCheck({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', prev: { attempts: 1, lastCheck: STALE },
      io: fake({ result: { status: null, stdout: '', stderr: '', timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 6 } } }) })
    expect(r).toBe(STALE)
  })
})

/**
 * The live run's one unfixed defect, four attempts running: the positive shim
 * imports `gilded.ui.views`, which does not exist. The model named the problem
 * correctly at least four times — once from a brief that showed it the traceback —
 * and wrote the import again. Telling it what is absent does not stick; a LISTING
 * of what is present is a different instrument, and it is free.
 *
 * Every name in the map comes from `listDir`. Nothing is authored, so the map
 * cannot claim a module the tree does not have.
 */
describe('readPackageMap / packageMapText', () => {
  const TREE = {
    'C:/b/gilded': ['__init__.py', 'world.py', 'save.py', 'settings.py', 'assets', '__pycache__', 'ui', 'society', 'tests'],
    'C:/b/gilded/ui': ['__init__.py', 'app.py', 'registry.py', 'widgets.py'],
    'C:/b/gilded/society': ['__init__.py', 'schemes.py'],
    'C:/b/gilded/tests': ['test_world.py'],
    'C:/b/gilded/assets': ['map.png', 'theme.ogg'],
    'C:/b/gilded/__pycache__': ['world.cpython-314.pyc'],
  }
  const io = (tree = TREE) => ({ listDir: (p) => tree[norm(p)] ?? [] })

  it('lists the .py modules of gilded/ and gilded/ui/, sorted', () => {
    const m = readPackageMap({ baseDir: 'C:/b', io: io() })
    expect(m.root).toEqual(['__init__.py', 'save.py', 'settings.py', 'world.py'])
    expect(m.ui).toEqual(['__init__.py', 'app.py', 'registry.py', 'widgets.py'])
  })

  // A subpackage is something a shim could import. `assets/` is data and
  // `__pycache__/` is noise; neither is importable, so neither is listed.
  it('lists only subpackage directories that hold python', () => {
    expect(readPackageMap({ baseDir: 'C:/b', io: io() }).subpackages).toEqual(['society', 'tests', 'ui'])
  })

  it('is null when the BASE archive has no gilded package to read', () => {
    expect(readPackageMap({ baseDir: 'C:/b', io: io({}) })).toBeNull()
    expect(packageMapText(null)).toBe('')
  })

  it('renders the heading, the names, and the sentence that names the absent module', () => {
    const t = packageMapText(readPackageMap({ baseDir: 'C:/b', io: io() }))
    expect(t).toContain('PACKAGE MAP (listed from the BASE archive — these modules exist; nothing else under gilded/ui does)')
    for (const n of ['world.py', 'save.py', 'settings.py', 'app.py', 'registry.py', 'widgets.py', 'society/', 'tests/']) {
      expect(t).toContain(n)
    }
    expect(t).toContain('There is no `gilded.ui.views`. Import only modules named here; a shim that')
    expect(t).toContain('imports a module absent from this map cannot pass.')
  })

  // The whole point: the map is a listing, so it can never name a module the
  // tree lacks — including the one the model keeps importing.
  it('lists nothing the fake tree does not have', () => {
    const t = packageMapText(readPackageMap({ baseDir: 'C:/b', io: io() }))
    const listed = t.split(/\n/).filter(l => /^ {4}\S/.test(l)).join(' ').trim().split(/\s+/)
    const real = new Set([...TREE['C:/b/gilded'], ...TREE['C:/b/gilded/ui'], 'society/', 'tests/', 'ui/'])
    for (const n of listed) expect(real.has(n)).toBe(true)
    // views.py is in neither the tree nor the listing — only in the warning line.
    expect(listed).not.toContain('views.py')
    expect(listed).not.toContain('map.png')
    expect(listed).not.toContain('world.cpython-314.pyc')
  })

  it('reaches the brief inside THE GAME AT BASE, before WHAT TO WRITE', () => {
    const t = authoringBrief({ line: LINE, id: ID, prevId: 'c8', baseDir: 'C:/b', stagingDir: `${home}/authoring/c9`,
      exemplar: null, packageMap: readPackageMap({ baseDir: 'C:/b', io: io() }) })
    expect(t).toContain('PACKAGE MAP (listed from the BASE archive')
    expect(t).toContain('There is no `gilded.ui.views`.')
    expect(t.indexOf('PACKAGE MAP')).toBeGreaterThan(t.indexOf('THE GAME AT BASE'))
    expect(t.indexOf('PACKAGE MAP')).toBeLessThan(t.indexOf('WHAT TO WRITE'))
  })

  it('omits the subsection entirely when the tree cannot be read', () => {
    const t = authoringBrief({ line: LINE, id: ID, prevId: 'c8', baseDir: 'C:/b', stagingDir: `${home}/authoring/c9`, exemplar: null, packageMap: null })
    expect(t).not.toContain('PACKAGE MAP')
    expect(t).toContain('THE GAME AT BASE')
  })
})

describe('positiveLeavesFailing', () => {
  it('is the failing ids in the shim tail', () => {
    expect(positiveLeavesFailing(gateLog({ [IDS[0]]: 'PASS' }, 'GATE: MISS (8 fails)'))).toEqual(IDS.slice(1))
  })
  it('is empty for a tail with nothing in it', () => {
    expect(positiveLeavesFailing(null)).toEqual([])
    expect(positiveLeavesFailing('   ')).toEqual([])
  })
})

describe('checkStagedViaSubprocess', () => {
  const runner = (r) => ({ run: (cmd, args, opts) => ({ ...r, _call: { cmd, args, opts } }) })

  // The tails run to ~12 KB and the MODEL runs `--check` too: every one of its
  // runs would otherwise end in a wall of its own output, re-read into its
  // context for nothing. The runner asks for them; the brief's command does not.
  it('asks for the tails with --json, which the brief\'s DONE WHEN command omits', async () => {
    const calls = []
    await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: { run: (cmd, args, opts) => { calls.push({ cmd, args }); return { status: 0, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: true, problems: [], lineIds: IDS }), stderr: '', fault: null, timedOut: false } } } })
    expect(calls[0].args).toEqual([SELF_SCRIPT, '--check', 'C:/s/c9', 'C:/b', '--json'])
    expect(checkCommand('C:/s/c9', 'C:/b')).not.toContain('--json')
  })

  it('reads the verdict from the [check-json] line', async () => {
    const payload = { ok: true, problems: [], lineIds: IDS, tails: { base: 'b', perturb: 'p', positive: 'x' } }
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: 0, stdout: `[check] c9: PASS\n${CHECK_JSON_MARKER}${JSON.stringify(payload)}\n`, stderr: '', fault: null, timedOut: false }) })
    expect(r.ok).toBe(true)
    expect(r.lineIds).toEqual(IDS)
    expect(r.tails.positive).toBe('x')
  })

  it('carries the located problems across the process boundary, dropping malformed entries', async () => {
    const problem = 'lint: the gate imports socket — a gate that reaches the network is not measuring the repo (gate_c9.py:3)'
    const payload = { ok: false, problems: [problem], at: [{ file: 'gate_c9.py', line: 3, problem }, { file: 1 }, null], lineIds: IDS }
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: 1, stdout: CHECK_JSON_MARKER + JSON.stringify(payload), stderr: '', fault: null, timedOut: false }) })
    expect(r.at).toEqual([{ file: 'gate_c9.py', line: 3, problem }])
    const old = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: 1, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: false, problems: ['x'], lineIds: IDS }), stderr: '', fault: null, timedOut: false }) })
    expect(old.at).toEqual([])
  })

  it('takes the LAST marker line, so a tail that quotes one cannot win', async () => {
    const decoy = CHECK_JSON_MARKER + JSON.stringify({ ok: true, problems: [], lineIds: [] })
    const real = CHECK_JSON_MARKER + JSON.stringify({ ok: false, problems: ['positive shim did not PASS'], lineIds: IDS })
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: 1, stdout: `${decoy}\nnoise\n${real}\n`, stderr: '', fault: null, timedOut: false }) })
    expect(r.ok).toBe(false)
    expect(r.problems).toEqual(['positive shim did not PASS'])
  })

  it('never calls a refusal a pass, even if the JSON says ok', async () => {
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: 1, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: true, problems: [], lineIds: IDS }), stderr: '', fault: null, timedOut: false }) })
    expect(r.ok).toBe(false)
  })

  it('reports a spawn fault as a harness fault and grades nothing', async () => {
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b',
      io: runner({ status: null, stdout: '', stderr: '', timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 6 } }) })
    expect(r.ok).toBe(false)
    expect(r.lineIds).toEqual([])
    expect(r.problems[0]).toMatch(/harness fault: the re-check subprocess did not run \(code ETIMEDOUT, status null, after 6 ms\)/)
  })

  it('reports a real timeout as a timeout', async () => {
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', timeoutMs: 1000,
      io: runner({ status: null, stdout: '', stderr: '', timedOut: true, fault: null }) })
    expect(r.problems[0]).toMatch(/timed out after 1000 ms/)
  })

  // Review I4: the check subprocess runs the harness's own, unsealed code.
  it('refuses to run under a harness closure that changed since dispatch, naming the files', async () => {
    const calls = []
    const atDispatch = { sha256: 'a', files: { 'cynco-gate-author.mjs': '1', 'cynco-campaign-calibrate.mjs': '2' } }
    const now = { sha256: 'b', files: { 'cynco-gate-author.mjs': '1', 'cynco-campaign-calibrate.mjs': 'EDITED' } }
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', harness: atDispatch,
      io: { harnessHash: () => now, run: (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: true, problems: [], lineIds: IDS }), stderr: '', fault: null, timedOut: false } } } })
    expect(calls).toHaveLength(0)                                  // a dirty instrument is not run at all
    expect(r.ok).toBe(false)
    expect(r.harnessDirty).toBe(true)
    expect(r.harnessDirtyFiles).toEqual(['cynco-campaign-calibrate.mjs'])
    expect(r.problems[0]).toMatch(/^harness dirty: cynco-campaign-calibrate\.mjs/)
    const rec = checkRecord(r, { now: () => 'T' })
    expect(rec.kind).toBe('fault')
    expect(rec.harnessDirty).toBe(true)
    expect(rec.harnessDirtyFiles).toEqual(['cynco-campaign-calibrate.mjs'])
  })

  it('runs normally when the closure is the one it was dispatched under', async () => {
    const same = { sha256: 'a', files: { 'x.mjs': '1' } }
    const r = await checkStagedViaSubprocess({ id: ID, stagingDir: 'C:/s/c9', baseDir: 'C:/b', harness: same,
      io: { harnessHash: () => ({ ...same }), ...runner({ status: 0, stdout: CHECK_JSON_MARKER + JSON.stringify({ ok: true, problems: [], lineIds: IDS }), stderr: '', fault: null, timedOut: false }) } })
    expect(r.ok).toBe(true)
    expect(r.harnessDirty).toBeUndefined()
    expect(checkRecord(r, { now: () => 'T' })).not.toHaveProperty('harnessDirty')
  })
})

describe('harness closure (review I4)', () => {
  it('reads static relative imports, multi-line and re-exports included, and skips bare specifiers and comments', () => {
    const src = [
      "import { a } from './one.mjs'",
      'import {',
      '  b,',
      '  c,',
      "} from './two.mjs'",
      "import { spawnSync } from 'node:child_process'",
      "export { d } from './three.mjs'",
      "import './four.mjs'",
      "// import { e } from './commented.mjs'",
      " * import { f } from './doc-comment.mjs'",
      "const g = await import('./dynamic.mjs')",
    ].join('\n')
    expect(staticRelativeImports(src).sort()).toEqual(['./four.mjs', './one.mjs', './three.mjs', './two.mjs'])
  })

  it('derives the acceptance test\'s closure from the real imports — the six named modules are in it', () => {
    const names = harnessClosure().map(f => basename(f))
    for (const n of ['cynco-gate-author.mjs', 'cynco-gate-lint.mjs', 'cynco-gate-parse.mjs', 'cynco-campaign-calibrate.mjs', 'cynco-campaign-grade.mjs', 'cynco-spawn.mjs']) {
      expect(names).toContain(n)
    }
  })

  // Phase 4 closed the Phase 3 residual: the engine modules `--check` loads run
  // their top-level code in the subprocess, so they are part of the instrument.
  it('follows ../engine/ imports into the engine, resolving .js to .ts, bounded to the repo and clear of node_modules', () => {
    const repoRoot = norm(dirname(dirname(SELF_SCRIPT)))
    const rel = harnessClosure().map(f => norm(f).slice(repoRoot.length + 1))
    for (const f of ['engine/paths.ts', 'engine/bridge/contractAutoCreate.ts', 'engine/tools/contractVerify.ts', 'engine/tools/contract.ts', 'engine/tools/shellInfo.ts', 'engine/training/gitFacts.ts', 'engine/cybernetics-core/src/index.ts']) {
      expect(rel).toContain(f)
    }
    expect(rel.some(f => f.split('/').includes('node_modules'))).toBe(false)
    expect(harnessClosure().every(f => norm(f).startsWith(repoRoot + '/'))).toBe(true)
    // Only scripts/ and engine/ — a scripts module's other ../ imports are not followed.
    expect(rel.every(f => f.startsWith('scripts/') || f.startsWith('engine/'))).toBe(true)
  })

  it('walks an injected tree: .js→.ts then .tsx, extensionless → index.ts, node_modules and out-of-repo skipped', () => {
    const tree = {
      'R:/repo/scripts/entry.mjs': "import { a } from './sib.mjs'\nimport { p } from '../engine/paths.js'\nimport { v } from '../engine/view.js'\nimport { d } from '../docs/not-followed.mjs'\nimport a from '../engine/../../outside.mjs'",
      'R:/repo/scripts/sib.mjs': "export const a = 1",
      'R:/repo/engine/paths.ts': "import { t } from './types'\nimport { x } from '../node_modules/pkg/index.js'\nimport { o } from '../../outside/evil.js'",
      'R:/repo/engine/view.tsx': "export const v = 1",
      'R:/repo/engine/types/index.ts': "export type T = 1",
      'R:/repo/docs/not-followed.mjs': "",
      'R:/repo/node_modules/pkg/index.js': "",
      'R:/outside/evil.js': "",
      'R:/outside.mjs': "",
    }
    const got = harnessClosure('R:/repo/scripts/entry.mjs', (p) => tree[p], (p) => p in tree)
    expect(got).toEqual(['R:/repo/engine/paths.ts', 'R:/repo/engine/types/index.ts', 'R:/repo/engine/view.tsx', 'R:/repo/scripts/entry.mjs', 'R:/repo/scripts/sib.mjs'])
    expect(got.map(f => harnessFileKey(f, 'R:/repo/scripts/entry.mjs'))).toEqual(['engine/paths.ts', 'engine/types/index.ts', 'engine/view.tsx', 'entry.mjs', 'sib.mjs'])
  })

  it('fingerprints the closure per file, and names exactly the files that differ', () => {
    const fp = harnessFingerprint()
    expect(fp.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(fp.files)).toEqual(harnessClosure().map(f => harnessFileKey(f)))
    expect(fp.files['engine/tools/contractVerify.ts']).toMatch(/^[0-9a-f]{64}$/)
    expect(harnessDirtyFiles(fp, harnessFingerprint())).toEqual([])
    const moved = { sha256: 'x', files: { ...fp.files, 'cynco-gate-lint.mjs': 'edited', 'cynco-new.mjs': 'added' } }
    delete moved.files['cynco-spawn.mjs']
    expect(harnessDirtyFiles(fp, moved)).toEqual(['cynco-gate-lint.mjs', 'cynco-new.mjs', 'cynco-spawn.mjs'])
  })
})

describe('restoreUncommittedWork', () => {
  const io = ({ exists = true, checkStatus = 0, applyStatus = 0, checkFault = null } = {}) => {
    const ran = []
    return { ran, exists: () => exists,
      run: (cmd, args) => {
        ran.push([cmd, ...args].join(' '))
        if (args.includes('--check')) return { status: checkStatus, stdout: '', stderr: 'error: patch does not apply\n', fault: checkFault }
        if (args.includes('apply')) return { status: applyStatus, stdout: '', stderr: 'boom\n', fault: null }
        return { status: 0, stdout: '', stderr: '', fault: null }
      } }
  }

  it('says nothing when there is no mission or no patch', () => {
    expect(restoreUncommittedWork({ stagingDir: 'C:/s/c9', missionId: null, io: io() })).toBeNull()
    expect(restoreUncommittedWork({ stagingDir: 'C:/s/c9', missionId: 'm1', io: io({ exists: false }) })).toBeNull()
  })

  it('checks before it applies, applies, commits, and says so', () => {
    const fake = io()
    const note = restoreUncommittedWork({ stagingDir: 'C:/s/c9', missionId: 'm1', io: fake, snapshotDir: 'C:/tmp' })
    expect(fake.ran[0]).toBe('git -C C:/s/c9 apply --check C:/tmp/m1.uncommitted.patch')
    expect(fake.ran[1]).toBe('git -C C:/s/c9 apply C:/tmp/m1.uncommitted.patch')
    expect(fake.ran.join('\n')).toMatch(/commit -m restore uncommitted work from m1/)
    expect(note).toMatch(/WAS restored/)
    expect(note).toMatch(/restore uncommitted work from m1/)
  })

  // A half-applied patch is worse than none: the model would read a tree that
  // neither it nor the check has ever seen.
  it('leaves the tree alone and NAMES the reason when the patch does not apply', () => {
    const fake = io({ checkStatus: 1 })
    const note = restoreUncommittedWork({ stagingDir: 'C:/s/c9', missionId: 'm1', io: fake, snapshotDir: 'C:/tmp' })
    expect(fake.ran).toEqual(['git -C C:/s/c9 apply --check C:/tmp/m1.uncommitted.patch'])
    expect(note).toMatch(/was NOT restored/)
    expect(note).toMatch(/patch does not apply/)
    expect(note).toMatch(/nothing is half-applied/)
  })

  it('names a git that could not run at all', () => {
    const note = restoreUncommittedWork({ stagingDir: 'C:/s/c9', missionId: 'm1',
      io: io({ checkFault: { code: 'ENOENT', status: null, signal: null, elapsedMs: 2 } }), snapshotDir: 'C:/tmp' })
    expect(note).toMatch(/was NOT restored: git apply --check could not run \(code ENOENT/)
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
  // Review #11: every `--author` test hands over its own temp-dir state, so this
  // file never depends on the global CYNCO_HOME setup to stay off the live state.
  const tempState = (id = ID) => { const st = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), id)).load(); return () => st }

  it('--author refuses an id the roadmap does not carry', async () => {
    const { files } = staged(home)
    const { io } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), stateFor: tempState() } })
    expect(await authorMain(['--author', 'c99'], io)).toBe(2)
  })
  it('--author takes and releases the campaign lock', async () => {
    const { files } = staged(home)
    let released = 0
    const { io } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), stateFor: tempState(), releaseLock: () => { released++ } } })
    expect(await authorMain(['--author', ID], io)).toBe(0)
    expect(released).toBe(1)
  })
  it('--author refuses when another runner holds the lock', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), stateFor: tempState(), takeLock: () => ({ ok: false, path: 'p', pid: 7 }) } })
    expect(await authorMain(['--author', ID], io)).toBe(2)
    expect(dispatched).toEqual([])
  })

  // Review #7 (spec §4): a refusal before dispatch is exit 2; a check that ran
  // and raised no proposal — refused or faulted — is exit 1.
  it('--author exits 2 for a line that is not open/authoring, and releases the lock', async () => {
    const { files } = staged(home)
    let released = 0
    const road = () => { const r = ROADMAP(); r.lines.find(l => l.id === 'c9').status = 'proposed'; return r }
    const { io, dispatched } = makeIo({ home, files, over: { loadRoadmap: road, stateFor: tempState(), releaseLock: () => { released++ } } })
    expect(await authorMain(['--author', ID], io)).toBe(2)
    expect(dispatched).toEqual([])
    expect(released).toBe(1)
  })
  it('--author exits 2 when an earlier line is still in flight', async () => {
    const { files } = staged(home)
    const road = () => { const r = ROADMAP(); r.lines.find(l => l.id === 'c8').status = 'authoring'; return r }
    const { io, dispatched } = makeIo({ home, files, over: { loadRoadmap: road, stateFor: tempState() } })
    expect(await authorMain(['--author', ID], io)).toBe(2)
    expect(dispatched).toEqual([])
  })
  it('--author exits 1 when the check refuses the triple', async () => {
    const { files } = staged(home)
    const { io, dispatched } = makeIo({ home, files, check: { ok: false, problems: ['BASE must MISS the gate; terminator was PASS'] },
      over: { loadRoadmap: () => ROADMAP(), stateFor: tempState() } })
    expect(await authorMain(['--author', ID], io)).toBe(1)
    expect(dispatched).toHaveLength(1)
  })
  it('--author exits 1 when the check could not run (a fault)', async () => {
    const { files } = staged(home)
    const { io } = makeIo({ home, files, over: { loadRoadmap: () => ROADMAP(), stateFor: tempState() } })
    const inner = io.run
    io.run = (cmd, args, opts) => cmd === 'bun' && args.includes('--check')
      ? { status: null, stdout: '', stderr: '', elapsedMs: 6, timedOut: false, fault: { code: 'ETIMEDOUT', status: null, signal: null, elapsedMs: 6 } }
      : inner(cmd, args, opts)
    expect(await authorMain(['--author', ID], io)).toBe(1)
  })
})

// ── The seat's authority is read across every campaign, not one state file ──

describe('gateAuthorAuthorityAcrossCampaigns', () => {
  // `campaigns/` under its own temp home: the seats store is read from the
  // campaigns dir's parent, which must never be the shared os.tmpdir().
  const campaigns = (byId) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'seat-')), 'campaigns')
    mkdirSync(dir, { recursive: true })
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
    expect(gateAuthorAuthorityAcrossCampaigns(join(tmpdir(), 'no-such-campaigns-dir-' + Date.now()), { seatsHome: mkdtempSync(join(tmpdir(), 'empty-')) })).toBe(0)
  })

  it('ignores a state file whose authority is not a finite number', () => {
    expect(gateAuthorAuthorityAcrossCampaigns(campaigns({ c8: { gateAuthorAuthority: 'lots' }, c9: { gateAuthorAuthority: null } }))).toBe(0)
  })

  // Phase 4: the per-seat retained store is the seat's own home. The reading is
  // the higher of the store and every campaign's state — the store is where an
  // approval lands now, the campaign states are where every earlier one did.
  it('reads the retained seats store beside the campaigns dir, and takes the max', () => {
    const home = mkdtempSync(join(tmpdir(), 'seat-home-'))
    const dir = join(home, 'campaigns')
    mkdirSync(join(dir, 'c9'), { recursive: true })
    writeFileSync(join(dir, 'c9', 'state.json'), JSON.stringify({ id: 'c9', gateAuthorAuthority: 0 }))
    expect(gateAuthorAuthorityAcrossCampaigns(dir)).toBe(0)
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.5, decidedAt: 't', campaign: 'c8' })
    expect(gateAuthorAuthorityAcrossCampaigns(dir)).toBe(0.5)
    // An explicit store home wins over the one beside the campaigns dir.
    expect(gateAuthorAuthorityAcrossCampaigns(dir, { seatsHome: mkdtempSync(join(tmpdir(), 'empty-')) })).toBe(0)
  })

  it('a campaign value above the store still wins', () => {
    const home = mkdtempSync(join(tmpdir(), 'seat-home-'))
    const dir = join(home, 'campaigns')
    mkdirSync(join(dir, 'c8'), { recursive: true })
    writeFileSync(join(dir, 'c8', 'state.json'), JSON.stringify({ id: 'c8', gateAuthorAuthority: 0.5 }))
    writeSeats(home, readSeats(home), { seat: 'gate-author', authority: 0.25, decidedAt: 't', campaign: 'c7' })
    expect(gateAuthorAuthorityAcrossCampaigns(dir)).toBe(0.5)
  })
})

describe('--author at earned authority, end to end', () => {
  const runAuthor = async (seatState) => {
    // Under its own temp home, so the seats store read beside it is empty.
    const campaignsDir = join(mkdtempSync(join(tmpdir(), 'seat-e2e-')), 'campaigns')
    mkdirSync(campaignsDir, { recursive: true })
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
    expect(AUTHOR_INVARIANTS).toEqual({ editGapCap: 120, commitGapCap: 150, revertBan: true, codeIndexFirst: true })
  })

  // A resume is a smaller job than an authoring, and the evidence says so:
  // attempts 4 and 5 each burned four hours with three of the four files already
  // finished, attempt 5 spending 436 of 449 tool calls inspecting.
  it('a resume gets two hours, a fresh authoring four', () => {
    expect(AUTHOR_RESUME_TIMEOUT_S).toBe(7200)
    expect(authorTimeoutFor(1)).toBe(AUTHOR_TIMEOUT_S)
    expect(authorTimeoutFor(2)).toBe(AUTHOR_RESUME_TIMEOUT_S)
    expect(authorTimeoutFor(7)).toBe(AUTHOR_RESUME_TIMEOUT_S)
    expect(authorTimeoutFor(undefined)).toBe(AUTHOR_TIMEOUT_S)
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
    const { io, disk } = makeIo({ home, files, check: { ok: false, problems: ['BASE must MISS the gate; terminator was PASS'] },
      over: { applyProposalDecision } })
    const roadmap = ROADMAP()
    const state = new CampaignState(join(mkdtempSync(join(tmpdir(), 'camp-')), ID)).load()
    state.state.gateAuthorAuthority = GATE_AUTHOR_MAX_AUTHORITY
    const r = await authorCampaign({ id: ID, roadmap, state, io })
    expect(r.proposal).toBeNull()
    expect(r.sealed).toBeNull()
    expect(disk[`${home}/heldout/civkings-redesign/c9/gate_c9.py`]).toBeUndefined()
  })
})
