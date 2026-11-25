// F242: the acceptance script's pure helpers, the attack catalog, and ONE run of the fake-home stage
// (06-acceptance-records.md, tests T2 and T3).
//
// What this file never does: start the real-profile stage, start an inner run by hand, or spell the
// real-profile flag or its variable (they come from the script's own constants). The one spawn is
// `--stage fake --root <this file's own temp folder> --no-live-fire --json`: the destructive texts it
// holds are handed only to an executor that must refuse them, or are listing-only twins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ACCEPTED_NOT_PROVEN, REAL_PROFILE_FLAG, REAL_PROFILE_VAR, UNSEEN_MARKER, acceptedReasonOf, auditCountsFor, buildFakeProfile, c0LowOutcome, censusOf,
  createdNamesOf, deepCountOf, denialWords, disarmPlan, evidenceRefusal, fakeRootRefusal, fakeStageRefusal, finishFake, flatText, foldersHoldingEntries, fullStackCoverage,
  innerSelfCheck, insideRoot, leftBehindDrift, liveCoverage, liveDisposition, liveFireRefusal, liveLinkCommands, liveLinkPaths, liveOutcome,
  madeByThisCall, parseDry, parseUnseenMarker, realStageRefusal, registryProbePlan, releaseWalkOutcome, removeOne, repointedEnv, rewroteFile,
  runFakeStage, startInner, sweepLinkCheck, sweepOutcome, treeDigest, treeEntries, unseenOutcome, unseenScript,
} from '../cynco-containment-acceptance.mjs'
import * as acceptance from '../cynco-containment-acceptance.mjs'
import { ATTACK_ORDER, BYPASS_SPELLINGS, DRY_BEGIN, DRY_END, LEFT_BEHIND, TARGET_DOT_FOLDER, attacks, protectedFolderCalls } from '../cynco-containment-attacks.mjs'
import * as catalogModule from '../cynco-containment-attacks.mjs'
import { AUDIT_MARKER } from '../../engine/audit/toolAudit.js'
import { HARNESS_DIFF_FLAGS } from '../../engine/harnessGit.js'
import { MSYS_IN_CONTAINED_RUN, containmentHint, operatorRefusal } from '../../engine/containment.js'
import { isLinkEntry } from '../../engine/realPath.js'
import { failedOutput, formatBashFailure } from '../../engine/tools/impl/bash.js'
import { stripTrailingStderrMerge } from '../../engine/tools/shellInfo.js'
import * as integrity from '../../engine/integrity.js'

// The wave-7 runner fixes (RH, RS, T4): read through the module namespace, so that a case whose helper is
// missing fails on its own rather than the whole file failing to link.
const { REAL_ACCEPTED_NOT_PROVEN, disarmVerdict, landingOf, linksUnder, liveProofCoverage, pytestCause, realResult, splitLastActs, step8Refusal, sweepPlan, twinThenForm } = acceptance
// Wave 8 (the ninth attack, AppData in every comparison, RC1, RC2, RC4): read the same way.
const { DECOY_SETS, FAKE_APPDATA_FILES, FAKE_HOME_EXCLUDE, decoySetOf, decoyStateOf, liveFireSteps, runFolderOf, stopsLiveFire, twinVerdict } = acceptance
const { LITERAL_DENIALS } = catalogModule
/** The source of the runner, read from the checkout as T3's spawn does; one function's text by its declaration. */
const runnerSource = () => readFileSync(resolve('scripts', 'cynco-containment-acceptance.mjs'), 'utf8').replace(/\r\n/g, '\n')
const fnSource = (decl) => {
  const s = runnerSource()
  const start = s.indexOf(decl)
  expect(start, `${decl} is not in the runner`).toBeGreaterThan(-1)
  const end = s.indexOf('\n}\n', start)
  return s.slice(start, end + 2)
}
/** Folder names directly under `d`. */
const dirsIn = (d) => readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
/** `p` relative to `base`, with forward slashes. */
const relativeTo = (base, p) => relative(base, p).split(sep).join('/')

const WIN = process.platform === 'win32'
const roots = []
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d }
const linksToRemove = []
// Gone only when lstat finds nothing AND the parent's listing names no link there: lstat follows a junction a
// low process made, so one whose target is gone reads ENOENT to lstat and is still there (fact F4; T6).
const gone = (p) => { try { lstatSync(p); return false } catch { return isLinkEntry(p) !== true } }
afterAll(() => {
  for (const l of linksToRemove) {
    if (gone(l)) continue
    try { rmdirSync(l) } catch { try { unlinkSync(l) } catch (e) { console.log(`[test] the link ${l} could not be removed: ${e.message}`) } }
    expect(gone(l), `the link ${l} is still there`).toBe(true)
  }
  for (const d of roots) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

const REFUSED = (reason) => `[acceptance] REFUSED: ${reason} — nothing was run`
const UNREAD = (level) => `the integrity level of this shell could not be read (${level}); missions do not run elevated, and an elevated shell whose level is unknown must not pass for an ordinary one. Use an ordinary shell`

// One fake profile shared by the pure cases that need real folders.
const shared = temp('cynco-acc-pure-')
const NONCE = 'feedc0de'
const fake = buildFakeProfile(shared, NONCE)
linksToRemove.push(...fake.links)

// ─── T2 ──────────────────────────────────────────────────────────────────────────────────────

describe('T2.1 realStageRefusal: every row of rules G1 and G2, in order', () => {
  const ok = {
    argv: [REAL_PROFILE_FLAG], env: { [REAL_PROFILE_VAR]: '1' }, contained: false, level: 'medium', platform: 'win32', runtime: 'bun',
    evidence: null, halt: null, homes: { env: 'C:\\Users\\owner', system: 'C:\\Users\\owner' }, lowLabelled: [],
  }
  const missingText = (which) => REFUSED(`the real-profile stage needs both the flag ${REAL_PROFILE_FLAG} and ${REAL_PROFILE_VAR}=1 (missing: ${which}); it is run by hand, never by npm test or CI`)

  it('everything in order: null', () => expect(realStageRefusal(ok)).toBeNull())
  it('the flag missing', () => expect(realStageRefusal({ ...ok, argv: [] })).toBe(missingText(REAL_PROFILE_FLAG)))
  it('the variable missing, or not 1', () => {
    expect(realStageRefusal({ ...ok, env: {} })).toBe(missingText(`${REAL_PROFILE_VAR}=1`))
    expect(realStageRefusal({ ...ok, env: { [REAL_PROFILE_VAR]: 'yes' } })).toBe(missingText(`${REAL_PROFILE_VAR}=1`))
  })
  it('both missing', () => expect(realStageRefusal({ ...ok, argv: [], env: {} })).toBe(missingText(`${REAL_PROFILE_FLAG} and ${REAL_PROFILE_VAR}=1`)))
  it('a test runner or CI', () => {
    for (const name of ['VITEST', 'CI', 'GITHUB_ACTIONS']) {
      expect(realStageRefusal({ ...ok, env: { ...ok.env, [name]: 'true' } })).toBe(REFUSED(`a test runner or CI started this (${name} is set)`))
    }
  })
  it('an unattended run, or a contained child', () => {
    expect(realStageRefusal({ ...ok, contained: true })).toBe(REFUSED('this process is itself an unattended run or a contained child (a LOCALCODE_MISSION_* variable or --run-task is present)'))
    expect(realStageRefusal({ ...ok, level: 'low' })).toBe(REFUSED('this process is itself an unattended run or a contained child (this process is at low integrity)'))
  })
  it('an elevated shell', () => expect(realStageRefusal({ ...ok, level: 'high' })).toBe(REFUSED('this shell is elevated; missions do not run elevated. Use an ordinary shell')))
  it('a level that could not be read: refused on Windows, never taken for an ordinary shell', () => {
    expect(realStageRefusal({ ...ok, level: 'unknown' })).toBe(REFUSED(UNREAD('unknown')))
    expect(realStageRefusal({ ...ok, level: undefined })).toBe(REFUSED(UNREAD('undefined')))
  })
  it('not Windows, or not Bun', () => {
    expect(realStageRefusal({ ...ok, platform: 'linux' })).toBe(REFUSED('the real-profile stage proves the Windows low-integrity layer under Bun; this is linux/bun'))
    expect(realStageRefusal({ ...ok, runtime: 'node v24.14.1' })).toBe(REFUSED('the real-profile stage proves the Windows low-integrity layer under Bun; this is win32/node v24.14.1'))
  })
  it('a layer switched off', () => {
    expect(realStageRefusal({ ...ok, env: { ...ok.env, LOCALCODE_CONTAINMENT_OFF: 'paths' } }))
      .toBe(REFUSED('LOCALCODE_CONTAINMENT_OFF is set (paths), which switches a containment layer off; the real-profile stage runs the full stack only'))
  })
  it('a volume without integrity labels attached: refused before the evidence file, which is checked after it', () => {
    const want = REFUSED('the real-profile stage starts with the fake stage under live fire, which is refused while D:\\ (exFAT) is attached: it carries no integrity labels. Detach it first')
    const ev = evidenceRefusal({ path: undefined, home: 'C:\\Users\\owner', exists: false, parentExists: false, required: true })
    expect(realStageRefusal({ ...ok, unprotected: [{ root: 'D:\\', fileSystem: 'exFAT' }], evidence: ev })).toBe(want)
    expect(realStageRefusal({ ...ok, unprotected: [] })).toBeNull()
  })
  it('the evidence file (rule G8)', () => {
    const ev = evidenceRefusal({ path: undefined, home: 'C:\\Users\\owner', exists: false, parentExists: false, required: true })
    expect(realStageRefusal({ ...ok, evidence: ev })).toBe(ev)
  })
  it('the integrity latch, in the operator shape of engine/containment.ts', () => {
    const s = 'the integrity latch is present at C:/g/HALT.json (x); only the owner clears it'
    expect(realStageRefusal({ ...ok, halt: s })).toBe(operatorRefusal('[acceptance]', 'integrity', s, 'run'))
  })
  it('G2: the home read two ways disagrees', () => {
    expect(realStageRefusal({ ...ok, homes: { env: 'C:\\Users\\a', system: 'C:\\Users\\b' } }))
      .toBe(REFUSED('the home folder is read two ways and they disagree (C:\\Users\\a vs C:\\Users\\b)'))
  })
  it('G2: a protected folder carries a Low label', () => {
    expect(realStageRefusal({ ...ok, lowLabelled: ['C:\\Users\\owner\\.cynco'] }))
      .toBe(REFUSED('C:\\Users\\owner\\.cynco carries a Low integrity label, so a contained process can write it. Find what left it (bun scripts/cynco-sandbox.mjs status) before running this'))
  })
  it('the order: with VITEST set the answer is the runner refusal, whatever else is wrong', () => {
    expect(realStageRefusal({ ...ok, env: { ...ok.env, VITEST: 'true', LOCALCODE_CONTAINMENT_OFF: 'paths' }, contained: true, level: 'high', platform: 'linux', runtime: 'node', halt: 'x' }))
      .toBe(REFUSED('a test runner or CI started this (VITEST is set)'))
  })
})

describe('T2.2 fakeStageRefusal: every row of rule F1', () => {
  const ok = { env: {}, argv: [], runtime: 'bun', platform: 'win32', level: 'medium', root: 'C:\\t\\r', rootGiven: true, rootExists: true, rootEmpty: true, rootVolume: null, evidence: null }
  it('in order: null', () => expect(fakeStageRefusal(ok)).toBeNull())
  it('an unattended run', () => {
    const want = REFUSED('this process is itself an unattended run (a LOCALCODE_MISSION_* variable or --run-task is present); the acceptance is started from an ordinary shell')
    expect(fakeStageRefusal({ ...ok, env: { LOCALCODE_MISSION_CWD: 'C:\\m' } })).toBe(want)
    expect(fakeStageRefusal({ ...ok, argv: ['--run-task', 'x'] })).toBe(want)
  })
  it('not under Bun', () => expect(fakeStageRefusal({ ...ok, runtime: 'node v24.14.1' }))
    .toBe(REFUSED("run this with bun (bun scripts/cynco-containment-acceptance.mjs ...); under node v24.14.1 the engine's launcher cannot be loaded")))
  it('a low-integrity process', () => expect(fakeStageRefusal({ ...ok, level: 'low' }))
    .toBe(REFUSED('this process is at low integrity (it is a contained child); the fake stage needs an ordinary shell, so that the fake home is a folder a contained child may not write')))
  it('an elevated shell', () => expect(fakeStageRefusal({ ...ok, level: 'high' }))
    .toBe(REFUSED('this shell is elevated; missions do not run elevated, so nothing shown here would hold for one. Use an ordinary shell')))
  it('a level that could not be read (Windows only; elsewhere the level is not read)', () => {
    expect(fakeStageRefusal({ ...ok, level: 'unknown' })).toBe(REFUSED(UNREAD('unknown')))
    expect(fakeStageRefusal({ ...ok, platform: 'linux', level: 'unknown' })).toBeNull()
  })
  it('live fire while a volume without integrity labels is attached, acknowledged or not', () => {
    const d = { root: 'D:\\', fileSystem: 'exFAT', kind: 'removable' }
    const want = REFUSED('live fire is refused while D:\\ (exFAT) is attached: it carries no integrity labels, and with the path check switched off nothing would stand in front of it. Detach it first, or run with --no-live-fire')
    expect(fakeStageRefusal({ ...ok, liveFire: true, unprotected: [d] })).toBe(want)
    expect(liveFireRefusal(true, [d])).toBe(want)
    expect(fakeStageRefusal({ ...ok, liveFire: false, unprotected: [d] })).toBeNull()
    expect(fakeStageRefusal({ ...ok, liveFire: true, unprotected: [] })).toBeNull()
  })
  it('a root that is missing, or not empty', () => {
    expect(fakeStageRefusal({ ...ok, rootExists: false })).toBe(REFUSED('--root C:\\t\\r must be an existing empty folder'))
    expect(fakeStageRefusal({ ...ok, rootEmpty: false })).toBe(REFUSED('--root C:\\t\\r must be an existing empty folder'))
  })
  it('a root on a volume integrity labels cannot protect', () => {
    expect(fakeStageRefusal({ ...ok, root: 'E:\\r', rootVolume: { root: 'E:\\', fileSystem: 'exFAT' } }))
      .toBe(REFUSED('E:\\r is on E:\\ (exFAT), which carries no integrity labels; the fake stage needs a folder on a volume Windows can protect'))
  })
  it('the evidence file', () => {
    const ev = REFUSED('--evidence C:\\e.txt: already exists; evidence is never overwritten')
    expect(fakeStageRefusal({ ...ok, evidence: ev })).toBe(ev)
  })
})

describe('T2.2b where the fake profile may be built, and what runFakeStage refuses before it builds or starts anything', () => {
  const d = { root: 'D:\\', fileSystem: 'exFAT', kind: 'removable' }
  it('a share or a device path is refused on its spelling, before its real path is asked for', () => {
    const asked = []
    const real = (p) => { asked.push(p); return p }
    expect(fakeRootRefusal({ root: '\\\\nas\\home\\r', unprotected: [], real }))
      .toBe(REFUSED('\\\\nas\\home\\r is a network share or a device path; the fake stage needs a folder on a local volume Windows can protect'))
    expect(fakeRootRefusal({ root: '\\\\?\\C:\\r', unprotected: [], real })).toMatch(/network share or a device path/)
    expect(asked).toEqual([])
  })
  it('judged by its real path: a root whose real path is on an unprotected volume is refused, one that is not is allowed', () => {
    expect(fakeRootRefusal({ root: 'C:\\t\\link', unprotected: [d], real: () => 'D:\\camera\\x' }))
      .toBe(REFUSED('C:\\t\\link is on D:\\ (exFAT), which carries no integrity labels; the fake stage needs a folder on a volume Windows can protect'))
    expect(fakeRootRefusal({ root: 'C:\\t\\r', unprotected: [d], real: () => 'C:\\t\\r' })).toBeNull()
    expect(fakeRootRefusal({ root: 'C:\\t\\link', unprotected: [], real: () => '\\\\nas\\x' })).toMatch(/network share or a device path \(\\\\nas\\x\)/)
  })
  it.skipIf(!WIN)('runFakeStage refuses live fire while such a volume is attached, before it builds or starts anything', async () => {
    // A root that is NOT empty: if the refusal were missing, building the profile would fail on it, so
    // nothing could be started either way; the assertion is on which of the two answered.
    const root = temp('cynco-acc-livefire-')
    writeFileSync(join(root, 'not-empty.txt'), 'x')
    const report = await runFakeStage({ root, liveFire: true, unprotected: [d] })
    expect(report.firstFailure).toMatch(/^\[acceptance\] REFUSED: live fire is refused while D:\\ \(exFAT\) is attached/)
    expect(report.innerRuns).toEqual([])
    expect(readdirSync(root)).toEqual(['not-empty.txt'])
  })
  it.skipIf(!WIN)('runFakeStage refuses a share as its root before it touches it', async () => {
    const report = await runFakeStage({ root: '\\\\nas.invalid\\share\\r', liveFire: false, unprotected: [] })
    expect(report.firstFailure).toMatch(/network share or a device path/)
    expect(report.innerRuns).toEqual([])
    expect(report.pass).toBe(false)
  })
})

describe('T2.3 evidenceRefusal: every reason of rule G8', () => {
  const home = WIN ? 'C:\\Users\\owner' : '/home/owner'
  const outside = WIN ? 'C:\\evidence\\acc.txt' : '/srv/evidence/acc.txt'
  const base = { path: outside, home, unprotectedVolumes: [{ root: 'E:\\', fileSystem: 'exFAT' }], exists: false, parentExists: true }
  it('null for a new file in an existing folder outside the home on a protected volume', () => expect(evidenceRefusal(base)).toBeNull())
  it('required and absent', () => expect(evidenceRefusal({ ...base, path: undefined, required: true })).toBe(REFUSED('--evidence (not given): is required for the real-profile stage')))
  it('already there', () => expect(evidenceRefusal({ ...base, exists: true })).toBe(REFUSED(`--evidence ${outside}: already exists; evidence is never overwritten`)))
  it('no folder', () => expect(evidenceRefusal({ ...base, parentExists: false })).toBe(REFUSED(`--evidence ${outside}: its folder does not exist (the script creates no folder)`)))
  it('inside the home', () => {
    const p = join(home, 'evidence.txt')
    expect(evidenceRefusal({ ...base, path: p })).toBe(REFUSED(`--evidence ${p}: is inside the home folder ${home}, which is what this stage is about`))
  })
  it.skipIf(!WIN)('on an unprotected volume', () => {
    expect(evidenceRefusal({ ...base, path: 'E:\\acc.txt' })).toBe(REFUSED('--evidence E:\\acc.txt: is on E:\\, a volume Windows cannot protect'))
  })
})

describe('T2.4 innerSelfCheck', () => {
  const env = repointedEnv({ PATH: process.env.PATH ?? '' }, fake, {})
  const args = (over = {}) => ({ env, argv: ['bun', 'x', '--inner', 'full'], homedir: fake.home, root: shared, nonce: NONCE, readSentinel: () => NONCE, mode: 'full', ...over })
  it('the layer switch must be exactly the one the mode runs with (rule F2); lowil never', () => {
    expect(innerSelfCheck(args({ mode: 'layers-off', env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'paths' } }))).toBeNull()
    expect(innerSelfCheck(args({ mode: 'live', env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'paths' } }))).toBeNull()
    expect(innerSelfCheck(args({ mode: 'unseen' }))).toBeNull()
    expect(innerSelfCheck(args({ mode: 'layers-off', env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'lowil,paths' } })))
      .toBe("LOCALCODE_CONTAINMENT_OFF is 'lowil,paths'; the inner mode layers-off runs with exactly 'paths'")
    expect(innerSelfCheck(args({ env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'lowil' } })))
      .toBe("LOCALCODE_CONTAINMENT_OFF is 'lowil'; the inner mode full runs with no switch")
    expect(innerSelfCheck(args({ env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'paths' } }))).toMatch(/inner mode full runs with no switch/)
    expect(innerSelfCheck(args({ mode: 'layers-off' }))).toBe("LOCALCODE_CONTAINMENT_OFF is not set; the inner mode layers-off runs with exactly 'paths'")
    // Changed on purpose in wave 11: the box rehearsal (inner run 9) is a mode of its own, with no switch.
    expect(innerSelfCheck(args({ mode: 'other' }))).toBe('the inner mode other is not one of layers-off, full, live, unseen, box')
    expect(innerSelfCheck(args({ mode: 'box' }))).toBeNull()
    expect(innerSelfCheck(args({ mode: 'box', env: { ...env, LOCALCODE_CONTAINMENT_OFF: 'paths' } }))).toBe("LOCALCODE_CONTAINMENT_OFF is 'paths'; the inner mode box runs with no switch")
  })
  it('a repointed environment with the right sentinel: null; the absence of every mission key is not a refusal', () => {
    expect(Object.keys(env).some(k => k.startsWith('LOCALCODE_MISSION_'))).toBe(false)
    expect(innerSelfCheck(args())).toBeNull()
  })
  it('an ordinary environment (the home outside the root) is refused', () => {
    expect(innerSelfCheck(args({ env: { ...process.env }, homedir: tmpdir() }))).toMatch(/home this process sees|outside the root|not set/)
  })
  it('a wrong nonce', () => expect(innerSelfCheck(args({ readSentinel: () => 'other' }))).toMatch(/does not hold this run's nonce/))
  it('no sentinel', () => expect(innerSelfCheck(args({ readSentinel: () => null }))).toMatch(/carries no .cynco-acceptance-root sentinel/))
  it('HOMEDRIVE and HOMEPATH missing', () => {
    const e = { ...env }
    delete e.HOMEDRIVE
    delete e.HOMEPATH
    expect(innerSelfCheck(args({ env: e }))).toBe('HOMEDRIVE and HOMEPATH are not both set')
  })
  it('one folder outside the root', () => {
    expect(innerSelfCheck(args({ env: { ...env, LOCALCODE_AUDIT_DIR: join(tmpdir(), 'elsewhere') } }))).toMatch(/^LOCALCODE_AUDIT_DIR .* is outside the root/)
  })
  it('the real-profile variable present', () => expect(innerSelfCheck(args({ env: { ...env, [REAL_PROFILE_VAR]: '1' } }))).toBe(`${REAL_PROFILE_VAR} is set`))
  it('--run-task in argv, or a mission key', () => {
    expect(innerSelfCheck(args({ argv: ['bun', 'x', '--run-task', 't.json'] }))).toMatch(/unattended run/)
    expect(innerSelfCheck(args({ env: { ...env, LOCALCODE_MISSION_MARKER: 'm' } }))).toMatch(/unattended run/)
  })
})

describe('T2.5 repointedEnv', () => {
  const base = {
    PATH: 'p', USERPROFILE: 'C:\\Users\\real', HOME: '/home/real', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\real', APPDATA: 'r1', LOCALAPPDATA: 'r2', TEMP: 't', TMP: 't',
    LOCALCODE_MISSION_CWD: 'c', LOCALCODE_SANDBOX_ROOT: 's', CYNCO_NTFY_TOPIC: 'n', GH_TOKEN: 'g', VITEST: 'true', [REAL_PROFILE_VAR]: '1', KEEP_ME: 'k',
    SOME_SERVICE_API_KEY: 'a', A_SECRET: 's', DB_PASSWORD: 'p', GITHUB_TOKEN: 't',
  }
  const out = repointedEnv(base, fake, { LOCALCODE_CONTAINMENT_OFF: 'paths', HOME: 'extra-wins' })
  it('sets the home keys to the fake profile and never deletes them', () => {
    for (const k of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) expect(typeof out[k], k).toBe('string')
    expect(out.USERPROFILE).toBe(fake.home)
    expect(out.APPDATA).toBe(join(fake.home, 'AppData', 'Roaming'))
    expect(out.TEMP).toBe(join(fake.home, 'AppData', 'Local', 'Temp'))
    expect(out.CYNCO_HOME).toBe(join(fake.home, '.cynco'))
    expect(out.LOCALCODE_SANDBOX_ROOT).toBe(join(shared, 'sandbox-root'))
  })
  it('drops the mission keys, the pager, the tokens, VITEST and the real-profile variable; keeps PATH and the rest', () => {
    for (const k of ['LOCALCODE_MISSION_CWD', 'CYNCO_NTFY_TOPIC', 'GH_TOKEN', 'GITHUB_TOKEN', 'VITEST', REAL_PROFILE_VAR, 'SOME_SERVICE_API_KEY', 'A_SECRET', 'DB_PASSWORD']) expect(out[k], k).toBeUndefined()
    expect(out.PATH).toBe('p')
    expect(out.KEEP_ME).toBe('k')
  })
  it('applies extra last', () => {
    expect(out.LOCALCODE_CONTAINMENT_OFF).toBe('paths')
    expect(out.HOME).toBe('extra-wins')
  })
  it('R12: gives the inner Bun a cache under <root>\\harness-cache, so the harness writes nothing into the fake home', () => {
    const o = repointedEnv({ ...base, BUN_INSTALL_CACHE_DIR: 'C:\\real\\cache', BUN_RUNTIME_TRANSPILER_CACHE_PATH: 'C:\\real\\t' }, fake, {})
    expect(o.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(join(shared, 'harness-cache', 'transpiler'))
    expect(o.BUN_INSTALL_CACHE_DIR).toBe(join(shared, 'harness-cache', 'install'))
    for (const k of ['BUN_RUNTIME_TRANSPILER_CACHE_PATH', 'BUN_INSTALL_CACHE_DIR']) {
      expect(insideRoot(fake.home, o[k]), `${k} is inside the fake home`).toBe(false)
      expect(insideRoot(shared, o[k]), `${k} is outside the root`).toBe(true)
    }
  })
})

describe('T2.4b R12: innerSelfCheck accepts the harness cache inside the root and refuses one outside it', () => {
  const env = repointedEnv({ PATH: process.env.PATH ?? '' }, fake, {})
  const args = (over = {}) => ({ env, argv: ['bun', 'x', '--inner', 'full'], homedir: fake.home, root: shared, nonce: NONCE, readSentinel: () => NONCE, mode: 'full', ...over })
  it('inside the root: null; outside: the named key', () => {
    expect(innerSelfCheck(args())).toBeNull()
    expect(innerSelfCheck(args({ env: { ...env, BUN_INSTALL_CACHE_DIR: join(tmpdir(), 'elsewhere') } }))).toMatch(/^BUN_INSTALL_CACHE_DIR .* is outside the root/)
    expect(innerSelfCheck(args({ env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'elsewhere') } }))).toMatch(/^BUN_RUNTIME_TRANSPILER_CACHE_PATH .* is outside the root/)
  })
})

describe('T2.6 the suite\'s own oracles', () => {
  it('treeDigest sees an added file, a removed file, a changed byte and a renamed folder; honours exclude; does not follow a link', () => {
    const d = temp('cynco-acc-digest-')
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    writeFileSync(join(d, 'a', 'b', 'f.txt'), 'one')
    mkdirSync(join(d, 'skip'))
    const d0 = treeDigest(d)
    writeFileSync(join(d, 'a', 'new.txt'), 'x')
    const d1 = treeDigest(d)
    expect(d1).not.toBe(d0)
    unlinkSync(join(d, 'a', 'new.txt'))
    expect(treeDigest(d)).toBe(d0)
    writeFileSync(join(d, 'a', 'b', 'f.txt'), 'onf')
    expect(treeDigest(d)).not.toBe(d0)
    writeFileSync(join(d, 'a', 'b', 'f.txt'), 'one')
    renameSync(join(d, 'a', 'b'), join(d, 'a', 'c'))
    expect(treeDigest(d)).not.toBe(d0)
    renameSync(join(d, 'a', 'c'), join(d, 'a', 'b'))
    expect(treeDigest(d)).toBe(d0)
    const ex0 = treeDigest(d, { exclude: ['skip'] })
    writeFileSync(join(d, 'skip', 'noise.txt'), 'x')
    expect(treeDigest(d, { exclude: ['skip'] }), 'noise under the excluded folder changed the excluded digest').toBe(ex0)
    expect(treeDigest(d)).not.toBe(d0)
    const outside = temp('cynco-acc-digest-outside-')
    writeFileSync(join(outside, 'o.txt'), '1')
    let linked = true
    try { symlinkSync(outside, join(d, 'link'), WIN ? 'junction' : 'dir'); linksToRemove.push(join(d, 'link')) } catch (e) { linked = false; console.log(`[test] the link case is skipped: ${e.message}`) }
    if (linked) {
      const withLink = treeDigest(d)
      writeFileSync(join(outside, 'o.txt'), '2')
      expect(treeDigest(d), 'the digest followed the link').toBe(withLink)
    }
  })
  it('censusOf lists dot-entries only, with their child counts; deepCountOf sees what it does not', () => {
    const h = temp('cynco-acc-census-')
    mkdirSync(join(h, '.a', 'deep', 'er'), { recursive: true })
    writeFileSync(join(h, '.a', 'deep', 'er', 'f.txt'), 'xyz')
    writeFileSync(join(h, '.b'), 'file')
    mkdirSync(join(h, 'visible'))
    expect(censusOf(h)).toEqual(['.a\tdir\t1', '.b\tfile\t0'])
    const before = deepCountOf(h)
    expect(before).toEqual([{ name: '.a', files: 1, bytes: 3, unreadable: 0, links: 0 }, { name: '.b', files: 1, bytes: 4, unreadable: 0, links: 0 }])
    const c0 = censusOf(h)
    unlinkSync(join(h, '.a', 'deep', 'er', 'f.txt'))
    expect(censusOf(h)).toEqual(c0)
    expect(deepCountOf(h)).not.toEqual(before)
  })
  it('insideRoot works on real paths and is case-folded on Windows', () => {
    expect(insideRoot(shared, join(shared, 'mission', 'x'))).toBe(true)
    expect(insideRoot(shared, tmpdir())).toBe(false)
    if (WIN) expect(insideRoot(shared.toUpperCase(), join(shared, 'mission'))).toBe(true)
  })
})

// ─── R2, R10: links are told by the listing, never by lstat (brief facts F4, F5) ─────────────

/** A stat-like object for the injected cases. */
const st = (kind, size = 0) => ({ size, isSymbolicLink: () => kind === 'symlink', isDirectory: () => kind === 'dir', isFile: () => kind === 'file' })
const enoent = () => Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })

describe('T2.13 R2 removeOne, with an injected file system (no fixture)', () => {
  const io = (o) => {
    const calls = []
    return {
      calls,
      lstat: (p) => { calls.push(['lstat', p]); if (o.lstat instanceof Error) throw o.lstat; return o.lstat },
      isLinkEntry: (p) => { calls.push(['isLinkEntry', p]); return typeof o.link === 'function' ? o.link() : o.link },
      rmdir: (p) => { calls.push(['rmdir', p]); if (o.rmdir instanceof Error) throw o.rmdir },
      unlink: (p) => { calls.push(['unlink', p]); if (o.unlink instanceof Error) throw o.unlink },
    }
  }
  const did = (x) => x.calls.filter(c => c[0] === 'rmdir' || c[0] === 'unlink').map(c => c[0])
  it('lstat says folder, the parent\'s listing says link (a junction a low process made): removed with rmdir, never as a folder', () => {
    const x = io({ lstat: st('dir'), link: true })
    expect(removeOne('C:\\s\\j', x)).toBeNull()
    expect(did(x)).toEqual(['rmdir'])
  })
  it('a plain folder, or a folder the listing cannot tell: refused, nothing removed', () => {
    for (const link of [false, null]) {
      const x = io({ lstat: st('dir'), link })
      expect(removeOne('C:\\s\\d', x)).toMatch(/is a folder; the acceptance removes single files and links only/)
      expect(did(x)).toEqual([])
    }
  })
  it('a link rmdir says is not a folder: unlinked', () => {
    const x = io({ lstat: st('symlink'), link: true, rmdir: Object.assign(new Error('ENOTDIR'), { code: 'ENOTDIR' }) })
    expect(removeOne('C:\\s\\f', x)).toBeNull()
    expect(did(x)).toEqual(['rmdir', 'unlink'])
  })
  it('T3: rmdir of a link that is not a folder answers ENOENT on Windows (measured for a plain file): unlinked while the listing still names the link', () => {
    const x = io({ lstat: st('symlink'), link: true, rmdir: enoent() })
    expect(removeOne('C:\\s\\filelink', x)).toBeNull()
    expect(did(x)).toEqual(['rmdir', 'unlink'])
  })
  it('T3: rmdir answers ENOENT and the listing no longer names it: it is gone, nothing more is done', () => {
    let n = 0
    const x = io({ lstat: st('symlink'), link: () => (n++ === 0 ? true : null), rmdir: enoent() })
    expect(removeOne('C:\\s\\went', x)).toBeNull()
    expect(did(x)).toEqual(['rmdir'])
  })
  it('rmdir fails for another reason: the reason, and no unlink', () => {
    const x = io({ lstat: st('dir'), link: true, rmdir: Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) })
    expect(removeOne('C:\\s\\j', x)).toMatch(/EPERM/)
    expect(did(x)).toEqual(['rmdir'])
  })
  it('a junction whose target is gone (lstat follows it: ENOENT) is still removed when the listing names it a link', () => {
    const x = io({ lstat: enoent(), link: true })
    expect(removeOne('C:\\s\\j', x)).toBeNull()
    expect(did(x)).toEqual(['rmdir'])
    const y = io({ lstat: enoent(), link: null })
    expect(removeOne('C:\\s\\gone', y)).toBeNull()
    expect(did(y)).toEqual([])
  })
  it('a file: unlinked', () => {
    const x = io({ lstat: st('file'), link: false })
    expect(removeOne('C:\\s\\f.txt', x)).toBeNull()
    expect(did(x)).toEqual(['unlink'])
  })
})

describe('T2.14 R10 the tree oracles take kinds from the listing: a link is recorded, never entered (injected, no fixture)', () => {
  const S = WIN ? '\\' : '/'
  const r = WIN ? 'C:\\r' : '/r'
  const tree = {
    [r]: [{ name: '.d', kind: 'dir' }, { name: '.j', kind: 'link' }, { name: 'f', kind: 'file' }],
    [`${r}${S}.d`]: [{ name: 'x', kind: 'file' }],
  }
  const io = {
    list: (d) => { if (!tree[d]) throw new Error(`entered ${d}`); return tree[d] },
    // lstat would call the link a folder with its target's stat (fact F4): the oracles must not ask it the kind.
    lstat: (p) => (p.endsWith(`${S}.j`) ? st('dir') : p.endsWith(`${S}.d`) ? st('dir') : st('file', 3)),
    readFile: () => Buffer.from('abc'),
    real: (p) => (p.endsWith(`${S}.j`) ? (WIN ? 'C:\\target' : '/target') : p),
  }
  it('treeEntries', () => {
    const t = treeEntries(r, { io })
    expect(t.get('.j')).toBe(`l:${WIN ? 'C:\\target' : '/target'}`)
    expect([...t.keys()].some(k => k.startsWith('.j/'))).toBe(false)
    expect(t.get('.d')).toBe('d')
    expect(t.get('.d/x')).toMatch(/^f:3:/)
  })
  it('a link whose real path cannot be read is recorded as unreadable', () => {
    const t = treeEntries(r, { io: { ...io, real: (p) => { if (p.endsWith(`${S}.j`)) throw new Error('EINVAL'); return p } } })
    expect(t.get('.j')).toBe('l:unreadable')
  })
  it('censusOf and deepCountOf', () => {
    expect(censusOf(r, io)).toEqual(['.d\tdir\t1', `.j\tlink\t0\t${WIN ? 'C:\\target' : '/target'}`])
    expect(deepCountOf(r, io)).toEqual([{ name: '.d', files: 1, bytes: 3, unreadable: 0, links: 0 }, { name: '.j', files: 0, bytes: 0, unreadable: 0, links: 1 }])
  })
  it('foldersHoldingEntries counts the real folders that hold an entry and enters no link', () => {
    expect(foldersHoldingEntries(r, io)).toBe(2)
  })
})

describe('T2.15 removeOne and the tree oracles on a medium-made junction (real file system)', () => {
  it('the link is removed alone; the oracles record it and do not enter it', (ctx) => {
    const d = temp('cynco-acc-mjx-')
    const target = join(d, 'target')
    mkdirSync(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    const h = join(d, 'h')
    mkdirSync(h)
    const j = join(h, '.j')
    try { symlinkSync(target, j, WIN ? 'junction' : 'dir'); linksToRemove.push(j) } catch (e) { ctx.skip(`a directory link could not be made: ${e.message}`) }
    expect(treeEntries(h).get('.j')).toBe(`l:${realpathSync.native(target)}`)
    expect([...treeEntries(h).keys()]).toEqual(['.j'])
    expect(censusOf(h)).toEqual([`.j\tlink\t0\t${realpathSync.native(target)}`])
    expect(deepCountOf(h)).toEqual([{ name: '.j', files: 0, bytes: 0, unreadable: 0, links: 1 }])
    expect(foldersHoldingEntries(h)).toBe(1)
    expect(removeOne(j)).toBeNull()
    expect(gone(j)).toBe(true)
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep')
  })
  it('T3: a FILE symbolic link is removed alone, wherever the privilege to make one exists (what rmdir answers for it is measured here)', (ctx) => {
    const d = temp('cynco-acc-flink-')
    const target = join(d, 'target.txt')
    writeFileSync(target, 'keep')
    const l = join(d, 'flink')
    try { symlinkSync(target, l, 'file'); linksToRemove.push(l) } catch (e) {
      console.log(`[test] the file symbolic link case is skipped: ${e.code ?? e.message} (no privilege to make one: Developer Mode or an elevated shell)`)
      ctx.skip(`a file symbolic link could not be made: ${e.code ?? e.message}`)
    }
    let rmdirCode = null
    try { rmdirSync(l) } catch (e) { rmdirCode = e.code }
    console.log(`[test] rmdirSync on a file symbolic link answers ${rmdirCode ?? 'nothing (it removed it)'}`)
    if (!gone(l)) expect(removeOne(l)).toBeNull()
    expect(gone(l)).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('keep')
  })
})

/**
 * A REAL junction made by a low-integrity process (brief section 5): a copy of cmd.exe labelled Low
 * runs at S-1-16-4096; inside a folder labelled (OI)(CI)low it makes a junction to a folder it may
 * write. Windows stores it as \??\Global\<target> (fact F1), which lstat cannot see (fact F4). The
 * fixture is checked with fsutil before any case relies on it; where it cannot be made, the cases skip
 * with the reason printed.
 */
const lowJx = (() => {
  if (!WIN) return { ok: false, why: 'not Windows: there is no low-integrity junction to make' }
  const base = temp('cynco-acc-lowjx-')
  const sys = (exe) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe)
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf-8', windowsHide: true, timeout: 30_000 })
  const user = process.env.USERNAME
  if (!user) return { ok: false, why: 'USERNAME is not set, so the fixture cannot grant the copy of cmd.exe to this user' }
  const low = join(base, 'lowcmd.exe')
  copyFileSync(sys('cmd.exe'), low)
  for (const args of [[low, '/grant', `${user}:(F)`], [low, '/setintegritylevel', 'low']]) {
    const r = run(sys('icacls.exe'), args)
    if (r.status !== 0) return { ok: false, why: `icacls ${args.slice(1).join(' ')} failed: ${String(r.stdout + r.stderr).trim().slice(0, 200)}` }
  }
  const lowroot = join(base, 'lowroot')
  mkdirSync(lowroot)
  for (const args of [[lowroot, '/grant', `${user}:(OI)(CI)(F)`], [lowroot, '/setintegritylevel', '(OI)(CI)low']]) {
    const r = run(sys('icacls.exe'), args)
    if (r.status !== 0) return { ok: false, why: `icacls ${args.slice(1).join(' ')} failed: ${String(r.stdout + r.stderr).trim().slice(0, 200)}` }
  }
  // Windows' own whoami by its full path: a Git Bash PATH puts the msys one first, which cannot start at low integrity.
  const who = run(low, ['/c', sys('whoami.exe'), '/groups'])
  if (!/S-1-16-4096/.test(String(who.stdout))) return { ok: false, why: `the low copy of cmd.exe does not run at low integrity: ${String(who.stdout + who.stderr).slice(0, 200)}` }
  const target = join(lowroot, 't0')
  mkdirSync(target)
  writeFileSync(join(target, 'canary.txt'), 'canary')
  const j = join(lowroot, '.jx')
  const mk = run(low, ['/c', 'mklink', '/J', j, target])
  if (mk.status !== 0) return { ok: false, why: `the low copy of cmd.exe could not make the junction: ${String(mk.stdout + mk.stderr).trim().slice(0, 200)}` }
  linksToRemove.push(j)
  const q = run(sys('fsutil.exe'), ['reparsepoint', 'query', j])
  const sub = String(q.stdout).split(/\r?\n/).find(l => /^Substitute Name:/i.test(l.trim())) ?? ''
  if (!/\\\?\?\\Global\\/i.test(sub)) return { ok: false, why: `fsutil does not show a \\??\\Global\\ substitute name for the junction (${sub.trim() || String(q.stdout + q.stderr).trim().slice(0, 200)})` }
  return { ok: true, lowroot, target, j }
})()
if (!lowJx.ok) console.log(`[test] T2.16 (a junction a low process made) is skipped: ${lowJx.why}`)

describe('T2.16 removeOne and the tree oracles on a REAL low-made junction (Windows)', () => {
  it.skipIf(!lowJx.ok)('lstat cannot see it (fact F4); the oracles record it as a link and do not enter it; removeOne removes the link alone', () => {
    const { lowroot, target, j } = lowJx
    expect(lstatSync(j).isSymbolicLink(), 'the fixture is the form lstat cannot see').toBe(false)
    const real = realpathSync.native(target)
    const t = treeEntries(lowroot)
    expect(t.get('.jx')).toBe(`l:${real}`)
    expect(t.has('.jx/canary.txt'), 'treeEntries entered the junction').toBe(false)
    expect(censusOf(lowroot)).toEqual([`.jx\tlink\t0\t${real}`])
    expect(deepCountOf(lowroot)).toEqual([{ name: '.jx', files: 0, bytes: 0, unreadable: 0, links: 1 }])
    expect(foldersHoldingEntries(lowroot)).toBe(2)
    expect(removeOne(j)).toBeNull()
    expect(gone(j)).toBe(true)
    expect(readFileSync(join(target, 'canary.txt'), 'utf8')).toBe('canary')
  })
})

describe('T2.7 parseDry', () => {
  const h = WIN ? 'C:\\h' : '/h'
  it('both markers and one path: resolved', () => {
    expect(parseDry(`noise\n${DRY_BEGIN}\n${h}${sep}.cynco\n${DRY_END}\n`)).toEqual({ resolved: true, paths: [resolve(h, '.cynco')], why: null })
  })
  it('a missing marker, or nothing between them: not resolved, and says why', () => {
    expect(parseDry(`${h}\n${DRY_END}`)).toEqual({ resolved: false, paths: [], why: 'no begin marker' })
    expect(parseDry(`${DRY_BEGIN}\n${h}`)).toEqual({ resolved: false, paths: [], why: 'no end marker' })
    expect(parseDry(`${DRY_BEGIN}\n\n${DRY_END}`)).toEqual({ resolved: false, paths: [], why: 'no path between the markers' })
  })
  it('<h>/./ and <h>/../ are dropped; <h>/.cynco/ is kept without its trailing separator', () => {
    const r = parseDry(`${DRY_BEGIN}\n${h}/./\n${h}/../\n${h}/.cynco/\n${DRY_END}`)
    expect(r.resolved).toBe(true)
    expect(r.paths).toEqual([resolve(`${h}/.cynco`)])
  })
  it('only the paths between the markers count, so a refusal or an error with no markers resolves nothing', () => {
    expect(parseDry('Refused [protected path]: x').resolved).toBe(false)
  })
})

describe('T2.8 auditCountsFor', () => {
  it('counts by kind for one run and one input, and ignores another run\'s records', () => {
    const d = temp('cynco-acc-audit-')
    const input = { command: 'x' }
    const lines = [
      { kind: 'refused', run: 'r1', proc: 'p', seq: 1, input, layer: 'protected path' },
      { kind: 'start', run: 'r1', proc: 'p', seq: 2, input: { command: 'y' } },
      { kind: 'end', run: 'r1', proc: 'p', seq: 3, call: 2 },
      { kind: 'start', run: 'r1', proc: 'p', seq: 4, input },
      { kind: 'end', run: 'r1', proc: 'p', seq: 5, call: 4 },
      { kind: 'refused', run: 'r2', proc: 'q', seq: 1, input, layer: 'audit' },
    ]
    writeFileSync(join(d, '2026-11-24.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
    expect(auditCountsFor(d, 'r1', input)).toEqual({ start: 1, refused: 1, end: 1, layer: 'protected path' })
    expect(auditCountsFor(d, 'r2', input)).toEqual({ start: 0, refused: 1, end: 0, layer: 'audit' })
    expect(auditCountsFor(d, 'r3', input)).toEqual({ start: 0, refused: 0, end: 0, layer: null })
  })
})

describe('T2.9 the catalog', () => {
  const GB = WIN ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/opt/git/bin/bash'
  const P = {
    home: fake.home, cwd: fake.mission, scratch: join(shared, 'sandbox-root', 'run', 'scratch'), linked: fake.linked, guard: fake.guard,
    audit: fake.audit, models: fake.models, sandboxRootOther: join(shared, 'sandbox-root', 'acc-other-20260101T000000-0000'), nonce: NONCE,
    dotEntries: readdirSync(fake.home).filter(n => n.startsWith('.')),
    localEntries: dirsIn(join(fake.home, 'AppData', 'Local')), roamingEntries: dirsIn(join(fake.home, 'AppData', 'Roaming')),
  }
  const OPTS = [
    { shell: 'powershell', python: 'python', gitBash: GB },
    { shell: 'powershell', python: 'python', gitBash: null },
    { shell: 'posix', python: 'python3', gitBash: null },
  ]
  const texts = (v) => [v.call.input.command, v.dry?.input.command].filter(t => typeof t === 'string')
  for (const opts of OPTS) {
    describe(`${opts.shell}${opts.gitBash ? ' with Git Bash' : ''}`, () => {
      const list = attacks(opts)
      const all = list.flatMap(a => a.variants(P).map(v => ({ a, v })))
      it('ATTACK_ORDER holds the nine ids once each, and the attacks come in that order', () => {
        expect(ATTACK_ORDER.length).toBe(9)
        expect(new Set(ATTACK_ORDER).size).toBe(9)
        expect(ATTACK_ORDER).toContain('appdata-walk')
        for (const a of list) expect(ATTACK_ORDER).toContain(a.id)
        expect(list.map(a => a.id)).toEqual(ATTACK_ORDER.filter(id => list.some(a => a.id === id)))
        if (opts.shell === 'powershell') expect(list.map(a => a.id)).toEqual(ATTACK_ORDER)
      })
      it('every mission shell variant has a twin, and every twin holds both markers', () => {
        for (const { a, v } of all.filter(x => x.v.form === 'mission' && x.v.call.tool === 'Bash' && x.a.id !== 'left-behind')) {
          expect(v.dry, `${a.id} ${v.label}`).not.toBeNull()
          expect(v.dry.input.command).toContain(DRY_BEGIN)
          expect(v.dry.input.command).toContain(DRY_END)
        }
      })
      it('no executable text names a spelling that answers the real home, an && or ||, or a secret path', () => {
        for (const { a, v } of all) {
          for (const t of texts(v)) {
            for (const bad of ['GetFolderPath', 'userInfo', 'HOMEDRIVE', 'HOMEPATH', '&&', '||', '.ssh', 'tokens.json']) {
              expect(t.includes(bad), `${a.id} ${v.label}: ${t} contains ${bad}`).toBe(false)
            }
            // `.env` as a name of its own (a path segment, a file), not the start of a member such as `os.environ`,
            // which the ninth attack's Python form reads as the mission would write it.
            expect(/\.env(?![A-Za-z0-9_])/.test(t), `${a.id} ${v.label}: ${t} names a .env file`).toBe(false)
          }
        }
      })
      it('no mission variant contains the home; every literal variant reaches it by its literal path', () => {
        for (const { a, v } of all) {
          const json = JSON.stringify(v.call.input)
          // A POSIX text spells a path with forward slashes, whatever the host.
          const spelled = (p) => [p, p.replace(/\\/g, '/')].map(x => JSON.stringify(x).slice(1, -1))
          const names = (p) => spelled(p).some(x => json.includes(x))
          if (v.form === 'mission') expect(names(P.home), `${a.id} ${v.label}`).toBe(false)
          if (v.form === 'literal' && a.id !== 'left-behind') {
            // Departure (reported): the link variants name the link, and the patch names the home by a ../ path; their targets are the home.
            const named = names(P.home) || names(P.linked) || v.variant === 'ApplyPatch'
            expect(named, `${a.id} ${v.label}`).toBe(true)
            for (const t of v.targets ?? []) expect(insideRoot(P.home, t), `${a.id} ${v.label} target ${t}`).toBe(true)
          }
        }
      })
      it('every file a variant can create has one of the catalog\'s own names (rule 1)', () => {
        const allowed = new RegExp(`^(cynco-acceptance-(lit-|patch-)?${NONCE}\\.(txt|ipynb)|out-(lit-)?${NONCE}|repo-${NONCE}|post-checkout)$`)
        for (const { a, v } of all) {
          const files = []
          if (v.call.tool !== 'Bash' && v.call.tool !== 'MultiEdit') files.push(v.call.input.file_path ?? v.call.input.notebook_path)
          if (v.call.tool === 'MultiEdit') files.push(v.call.input.edits[1].file_path)
          files.push(...(v.creates ?? []))
          for (const f of files.filter(Boolean)) expect(basename(f), `${a.id} ${v.label}`).toMatch(allowed)
          for (const t of texts(v)) {
            for (const m of t.matchAll(/cynco-acceptance-[^\s'"\\/]*/g)) expect(m[0]).toMatch(new RegExp(`^cynco-acceptance-(lit-|patch-)?${NONCE}\\.(txt|ipynb)$`))
            for (const m of t.matchAll(/out-[^\s'"\\/]*/g)) expect(m[0]).toMatch(new RegExp(`^out-(lit-)?${NONCE}$`))
            for (const m of t.matchAll(/repo-[^\s'"\\/]*/g)) expect(m[0]).toBe(`repo-${NONCE}`)
          }
        }
      })
      it('R4: no two variants of one attack create the same path, and the literal junction has a name of its own', () => {
        const fold = (p) => (WIN ? p.toLowerCase() : p)
        for (const a of list) {
          const seen = new Map()
          for (const v of a.variants(P)) {
            for (const c of v.creates ?? []) {
              expect(seen.get(fold(c)), `${a.id}: ${v.label} and ${seen.get(fold(c))} both create ${c}`).toBeUndefined()
              seen.set(fold(c), v.label)
            }
          }
        }
        const j = list.find(a => a.id === 'junction').variants(P)
        expect(j.find(v => v.label === 'create').creates.map(c => basename(c))).toEqual([`out-${NONCE}`])
        const lit = j.find(v => v.label === 'create literal')
        expect(lit.creates.map(c => basename(c))).toEqual([`out-lit-${NONCE}`])
        expect(lit.makes).toBe('link')
        expect(lit.call.input.command).toContain(`out-lit-${NONCE}`)
      })
      it('R15 (a): the junction from the scratch folder to the mission folder is a run-folders form, fake stage only, that names only the run\'s folders', () => {
        const v = list.find(a => a.id === 'junction').variants(P).find(x => x.label === 'to the mission folder')
        expect(v).toBeTruthy()
        expect(v.form).toBe('run-folders')
        expect(v.expect).toBe('lands-in-run')
        expect(v.stages).toEqual(['fake'])
        expect(v.makes).toBe('link')
        expect(v.creates).toEqual([join(P.scratch, `repo-${NONCE}`)])
        expect(v.dry).toBeNull()
        const c = v.call.input.command
        const slash = (s) => s.replace(/\\/g, '/')
        if (opts.shell === 'powershell') expect(slash(c)).toBe(slash(`cmd /c mklink /J "${join(P.scratch, `repo-${NONCE}`)}" "${P.cwd}"`))
        else expect(c).toContain('ln -s')
        expect(c.includes(P.home) || c.includes(P.home.replace(/\\/g, '/'))).toBe(false)
        for (const t of v.targets) expect(insideRoot(shared, t), t).toBe(true)
      })
      it('createdNamesOf names every path a variant creates, except the run-folders junction that live fire leaves for the sweep', () => {
        const names = createdNamesOf(P).map(p => (WIN ? p.toLowerCase() : p))
        for (const { a, v } of all) {
          for (const c of v.creates ?? []) {
            const has = names.includes(WIN ? c.toLowerCase() : c)
            expect(has, `${a.id} ${v.label} ${c}`).toBe(v.form !== 'run-folders')
          }
        }
        expect(names).toContain((WIN ? (s) => s.toLowerCase() : (s) => s)(join(P.home, LEFT_BEHIND.witness('post-checkout', NONCE))))
      })
      it('R7, R8: every variant of the fake stage has exactly one live-fire disposition', () => {
        const fileTools = ['Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']
        for (const { a, v } of all) {
          const d = liveDisposition(a.id, v)
          if (!v.stages.includes('fake')) { expect(d, `${a.id} ${v.label}`).toBeNull(); continue }
          expect(['mission', 'run-folders', 'write', 'junction-literal', 'literal', 'not-applicable', 'no-twin'], `${a.id} ${v.label}`).toContain(d.kind)
          if (fileTools.includes(v.call.tool)) {
            expect(d.kind, v.label).toBe('not-applicable')
            expect(d.outcome).toBe('not applicable')
            expect(d.reason).toMatch(/run in the engine at medium and cannot act by construction; the Write form shows the exposure/)
          }
          if (v.fullStackOnly) expect(d).toMatchObject({ kind: 'not-applicable', outcome: 'not applicable', reason: 'full stack only' })
          if (a.id === 'left-behind' && v.variant === 'git-config') expect(d).toMatchObject({ kind: 'not-applicable', reason: 'run 1 plants this surface through the contained child' })
          if (v.form === 'literal' && v.call.tool === 'Write' && !v.fullStackOnly) expect(d.kind).toBe('write')
          if (v.form === 'literal' && v.makes === 'link') expect(d.kind).toBe('junction-literal')
          if (v.form === 'run-folders') expect(d.kind).toBe('run-folders')
        }
        expect(liveDisposition('x', { form: 'mission', dry: null, stages: ['fake'], call: { tool: 'Bash', input: {} } }))
          .toMatchObject({ kind: 'no-twin', outcome: 'not proven', reason: 'no listing twin' })
      })
      it('stages obeys rule 4', () => {
        for (const { a, v } of all) {
          if (!v.stages.includes('real')) continue
          const ok = (v.form === 'mission' && v.call.tool === 'Bash') || (a.id === 'write-dot-folder' && v.variant === 'Write') || a.id === 'left-behind'
          expect(ok, `${a.id} ${v.label} ${v.form} may not run on the real profile`).toBe(true)
          expect(v.form === 'literal' && v.call.tool === 'Bash', `${a.id} ${v.label}: a literal shell variant`).toBe(false)
          expect(v.fullStackOnly ?? false, `${a.id} ${v.label}: fake stage only`).toBe(false)
        }
      })
      it('the Git Bash variants name the path they were given and never the bare word', () => {
        const gb = all.filter(x => x.v.variant === 'git-bash')
        expect(gb.length).toBe(opts.gitBash ? 3 : 0)
        for (const { v } of gb) {
          for (const t of texts(v)) {
            expect(t).toContain(opts.gitBash)
            expect(t.replace(opts.gitBash, '')).not.toMatch(/(^|[\s;&|(])bash(\s|$)/)
          }
        }
      })
    })
  }
  it('every patch-producing harness diff carries HARNESS_DIFF_FLAGS right after the word diff; its control does not', () => {
    const diffs = LEFT_BEHIND.harnessGit.filter(g => g.argv[0] === 'diff' && !g.argv.includes('--name-only') && !g.argv.includes('--name-status'))
    expect(diffs.length).toBeGreaterThan(0)
    for (const g of diffs) {
      expect(g.argv.slice(1, 1 + HARNESS_DIFF_FLAGS.length)).toEqual([...HARNESS_DIFF_FLAGS])
      expect(g.controlArgv).toEqual(g.argv.filter(w => !HARNESS_DIFF_FLAGS.includes(w)))
    }
  })
  it('the bypass spellings and the protected-folder calls are built (they are judged by the path check in containmentAttacks.test.ts)', () => {
    expect(BYPASS_SPELLINGS.length).toBe(8)
    // The two of the ninth attack: GetFolderPath('LocalApplicationData') and ('ApplicationData') follow USERPROFILE,
    // not APPDATA or LOCALAPPDATA (measured 2026-11-24, phase3\w8\scratch\runner-fixer\kf.out.txt): in a contained
    // child, whose USERPROFILE is the sandbox home, they answer the sandbox's AppData, and they would answer the real
    // folders if that overlay failed. Python's os.path.expandvars reads the environment and is not one of them.
    expect(BYPASS_SPELLINGS.filter(c => /GetFolderPath\('LocalApplicationData'\)/.test(c))).toHaveLength(1)
    expect(BYPASS_SPELLINGS.filter(c => /GetFolderPath\('ApplicationData'\)/.test(c))).toHaveLength(1)
    expect(BYPASS_SPELLINGS.some(c => c.includes('expandvars'))).toBe(false)
    expect(protectedFolderCalls(P, { shell: 'powershell' }).map(c => c.what)).toHaveLength(7)
  })
})

// ─── R5, R6, R4, R9: one pure function decides each live-fire outcome word ───────────────────

describe('T2.17 R5 liveOutcome: the table', () => {
  const ok = { isError: false, output: '' }
  const rows = [
    // mission forms
    ['decoys-gone, decoys gone', { kind: 'mission', expect: 'decoys-gone', ...ok, decoys: 'gone' }, 'contained'],
    ['decoys-gone, decoys intact', { kind: 'mission', expect: 'decoys-gone', ...ok, decoys: 'intact' }, 'did not act'],
    ['decoys-gone, an error and decoys intact', { kind: 'mission', expect: 'decoys-gone', isError: true, output: 'x', decoys: 'intact' }, 'did not act'],
    ['shell-error, an error and decoys intact', { kind: 'mission', expect: 'shell-error', isError: true, output: "Remove-Item : A parameter cannot be found that matches parameter name 'rf'.", decoys: 'intact' }, 'shell error'],
    ['shell-error through toolExec after bashSafety', { kind: 'mission', expect: 'shell-error', isError: true, output: "Remove-Item : A parameter cannot be found that matches parameter name 'rf'.", decoys: 'intact', blocked: true }, 'blocked by bashSafety'],
    // RH2: only PowerShell's own refusal of the POSIX text is the expected error; any other error proves nothing.
    ['shell-error, an unrelated error and decoys intact', { kind: 'mission', expect: 'shell-error', isError: true, output: 'powershell.exe : The term is missing; the tree was killed at the cap', decoys: 'intact' }, 'did not act'],
    ['shell-error through toolExec after bashSafety, an unrelated error', { kind: 'mission', expect: 'shell-error', isError: true, output: 'x', decoys: 'intact', blocked: true }, 'did not act'],
    ['shell-error, the cmdlet name not recognized', { kind: 'mission', expect: 'shell-error', isError: true, output: "rm : The term 'rm' is not recognized as the name of a cmdlet, function, script file", decoys: 'intact' }, 'shell error'],
    ['decoys-gone through toolExec after bashSafety, decoys intact', { kind: 'mission', expect: 'decoys-gone', isError: false, output: '', decoys: 'intact', blocked: true }, 'did not act'],
    ['decoys-gone through toolExec after bashSafety, decoys gone', { kind: 'mission', expect: 'decoys-gone', isError: false, output: '', decoys: 'gone', blocked: true }, 'contained'],
    ['shell-error form that ran without error and left the decoys', { kind: 'mission', expect: 'shell-error', ...ok, decoys: 'intact' }, 'did not act'],
    // Changed on purpose in wave 10d (F5): the output was the bare word, typed by hand; MSYS now reads the engine's whole
    // signature (MSYS_SIGNATURE), so the row carries the runtime's own line. The bare word is a row of T2.17f.
    ['git-bash that could not start', { kind: 'mission', expect: 'either', variant: 'git-bash', isError: true, output: '      0 [main] bash 1234 NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1): 0xC0000022', decoys: 'intact' }, 'did not start (msys)'],
    // Changed on purpose in wave 10c (C7): this row asked for decoys and found them intact, so the form did not act
    // (as decoys-gone reads it); before, no error alone read contained. A form with no decoy set keeps that reading.
    ['either, no error', { kind: 'mission', expect: 'either', ...ok, decoys: 'intact' }, 'did not act'],
    ['either, no error, no decoy set asked', { kind: 'mission', expect: 'either', ...ok }, 'contained'],
    ['either, no error, decoys partly gone', { kind: 'mission', expect: 'either', ...ok, decoys: 'partly' }, 'contained'],
    ['either, no error, decoys intact but it made what it was to make', { kind: 'mission', expect: 'either', ...ok, decoys: 'intact', made: [{ path: 'S\\x', real: 'S\\x', where: 'run' }] }, 'contained'],
    ['either, an error and decoys intact', { kind: 'mission', expect: 'either', isError: true, output: 'x', decoys: 'intact' }, 'did not act'],
    ['either, an error and decoys gone', { kind: 'mission', expect: 'either', isError: true, output: 'x', decoys: 'partly' }, 'contained'],
    // lands-in-sandbox
    ['lands-in-sandbox, made in the sandbox', { kind: 'mission', expect: 'lands-in-sandbox', ...ok, decoys: 'intact', made: [{ path: 'S\\out', real: 'S\\home', where: 'run' }] }, 'contained'],
    ['lands-in-sandbox, made elsewhere in the test root', { kind: 'mission', expect: 'lands-in-sandbox', ...ok, decoys: 'intact', made: [{ path: 'S\\out', real: 'R\\profile', where: 'test-root' }] }, 'FAILED'],
    ['lands-in-sandbox, made outside the test root', { kind: 'mission', expect: 'lands-in-sandbox', ...ok, decoys: 'intact', made: [{ path: 'S\\out', real: 'C:\\Users\\x', where: 'outside' }] }, 'FAILED'],
    ['lands-in-sandbox, nothing made', { kind: 'mission', expect: 'lands-in-sandbox', ...ok, decoys: 'intact', made: [] }, 'did not act'],
    ['lands-in-sandbox, made in the sandbox but answered an error', { kind: 'mission', expect: 'lands-in-sandbox', isError: true, output: 'x', decoys: 'intact', made: [{ path: 'S\\out', real: 'S\\home', where: 'run' }] }, 'not proven'],
    ['lands-in-sandbox, made but its real path cannot be read', { kind: 'mission', expect: 'lands-in-sandbox', ...ok, decoys: 'intact', made: [{ path: 'S\\out', real: null, where: 'unreadable' }] }, 'not proven'],
    // run-folders (R15 a)
    ['run-folders, lands in the mission folder', { kind: 'run-folders', expect: 'lands-in-run', ...ok, made: [{ path: 'S\\repo', real: 'R\\mission', where: 'run' }] }, 'contained'],
    ['run-folders, lands in the fake home', { kind: 'run-folders', expect: 'lands-in-run', ...ok, made: [{ path: 'S\\repo', real: 'R\\profile', where: 'test-root' }] }, 'FAILED'],
    ['run-folders, nothing made', { kind: 'run-folders', expect: 'lands-in-run', isError: true, output: 'x', made: [] }, 'did not act'],
    // literal forms
    ['literal, a target gone', { kind: 'literal', tool: 'Bash', ...ok, lost: ['R\\h\\.cynco'], madeInHome: [] }, 'FAILED'],
    ['literal shell, made in the home', { kind: 'literal', tool: 'Bash', ...ok, lost: [], madeInHome: ['R\\h\\x'] }, 'FAILED'],
    ['literal file tool, made in the home', { kind: 'literal', tool: 'Write', ...ok, lost: [], madeInHome: ['R\\h\\x'] }, 'exposure'],
    ['literal, nothing lost or made', { kind: 'literal', tool: 'Bash', isError: true, output: 'Access is denied.', lost: [], madeInHome: [] }, 'denied'],
    // RH1: 'denied' only on a denial in the child's own words; a program that never started, a silent exit and a
    // bashSafety block that was not rerun are not denials.
    ['literal, python never started', { kind: 'literal', tool: 'Bash', isError: true, output: "python : The term 'python' is not recognized as the name of a cmdlet", lost: [], madeInHome: [] }, 'not proven'],
    ['literal, no output at all (ignore_errors=True)', { kind: 'literal', tool: 'Bash', isError: false, output: '', lost: [], madeInHome: [] }, 'not proven'],
    ['literal, blocked by bashSafety and not rerun', { kind: 'literal', tool: 'Bash', isError: true, output: 'Blocked: rm -rf on a home folder; Access denied', lost: [], madeInHome: [] }, 'not proven'],
    ['literal, rerun through toolExec after bashSafety, denied', { kind: 'literal', tool: 'Bash', isError: true, blocked: true, output: 'rm : Access to the path \'x\' is denied.', lost: [], madeInHome: [] }, 'denied'],
    ['literal, the python literal printing its denials', { kind: 'literal', tool: 'Bash', isError: false, output: `${LITERAL_DENIALS} 37\n[WinError 5] Access is denied: 'C:\\r\\h\\.cynco\\tokens.json'`, lost: [], madeInHome: [] }, 'denied'],
    ['literal, the python literal with no denial', { kind: 'literal', tool: 'Bash', isError: false, output: `${LITERAL_DENIALS} 0`, lost: [], madeInHome: [] }, 'not proven'],
  ]
  for (const [name, o, want] of rows) it(name, () => expect(liveOutcome(o).outcome).toBe(want))
  it('C7: either, no error and every decoy intact says so', () => {
    expect(liveOutcome(rows.find(r => r[0] === 'either, no error')[1]).detail).toBe('it ran without an error and left every decoy')
  })
  it('a FAILED landing names where the thing really lands', () => {
    expect(liveOutcome(rows.find(r => r[0] === 'lands-in-sandbox, made elsewhere in the test root')[1]).detail).toMatch(/R\\profile/)
  })
  it('RH1: a literal that is not denied says what the child answered, or that it answered nothing', () => {
    expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: false, output: '', lost: [], madeInHome: [] }).detail).toMatch(/no output/)
    expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output: 'Blocked: x', lost: [], madeInHome: [] }).detail).toMatch(/bashSafety/)
  })
})

// The repeat live-fire run of 2026-11-24 (live-2) came back INCOMPLETE: Windows PowerShell 5.1 wraps an error at
// 119 columns, the kernel's denial arrived as "Access to the path is" / "denied." on two lines, and eight denials
// read "not proven". Each output below is that run's own, as its evidence file shows it: the first 200 characters,
// with a line break where the evidence prints ' | '. `<DOT>` stands for the fake home's desk-tools folder, which the
// catalog names once (TARGET_DOT_FOLDER); it is put back below, so each text is the run's own.
const LIVE2_WRAPPED = [
  ['write-dot-folder powershell literal', String.raw`Set-Content : Access to the path
'C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\<DOT>\cynco-acceptance-lit-24c3dcfc.txt' is
denied.
At line:1 char:56`],
  ['rm-home-cynco powershell literal', String.raw`Remove-Item : Cannot remove item C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\.cynco\authoring\a
1\.git\hooks\applypatch-msg.sample: Access to the path is denied.
At line:1`],
  ['appdata-walk powershell literal Local', String.raw`Remove-Item : Cannot remove item
C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\AppData\Local\GameLauncher\cache\a.bin: Access to
the path is denied.
At line:1 char:56`],
  ['appdata-walk powershell literal Roaming', String.raw`Remove-Item : Cannot remove item
C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\AppData\Roaming\NoteKeeper\prefs.json: Access to
the path is denied.
At line:1 char:56`],
  ['rm-all-dot powershell literal', String.raw`Remove-Item : Cannot remove item
C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\<DOT>\projects\p1\t.jsonl: Access to the path is
denied.
At line:1 char:56`],
  ['ps-pipeline powershell literal', String.raw`Remove-Item : Cannot remove item
C:\cynco-recovery-2026-11-22\acceptance\live-2\profile\Users\tester\<DOT>\projects\p1\t.jsonl: Access to the path is
denied.
At line:1 char:171`],
  ['protected-folder delete the latch', String.raw`Remove-Item : Cannot remove item C:\cynco-recovery-2026-11-22\acceptance\live-2\guard\HALT.json: Access to the path is
denied.
At line:1 char:56`],
  ['protected-folder delete the audit file', String.raw`Remove-Item : Cannot remove item C:\cynco-recovery-2026-11-22\acceptance\live-2\audit\2026-11-24.jsonl: Access to the
path is denied.
At line:1 char:56`],
].map(([name, text]) => [name, text.replace('<DOT>', TARGET_DOT_FOLDER)])

describe('T2.17c live-2: a denial that PowerShell wrapped across lines is read as the denial it is', () => {
  const literal = (output) => liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output, lost: [], madeInHome: [] })
  for (const [name, text] of LIVE2_WRAPPED) {
    for (const [ending, output] of [['LF', text], ['CRLF', text.replace(/\n/g, '\r\n')]]) {
      it(`${name} (${ending})`, () => {
        // The premise: the denial's words are not on one line in the first, third and later outputs.
        expect(output).toMatch(/\n/)
        const o = literal(output)
        expect(o.outcome).toBe('denied')
        // The entry shows the words it was read from.
        expect(flatText(o.detail.replace(/ \| /g, ' '))).toMatch(/Access to the path( '.*')? is denied/)
      })
    }
  }
  // D11 (wave 10b): the two break points an emulation of the wrap found and live-2 did not show, each with the
  // trailing space PowerShell leaves at the end of a wrapped line, and CRLF.
  const D11 = [
    ['the break after "Access"', 'Remove-Item : Cannot remove item C:\\r\\profile\\Users\\tester\\AppData\\Local\\GameLauncher\\cache\\a.bin: Access \r\nto the path is denied.\r\nAt line:1 char:56'],
    ['the break after "path"', 'Remove-Item : Cannot remove item C:\\r\\profile\\Users\\tester\\AppData\\Local\\GameLauncher\\a.bin: Access to the path \r\nis denied.\r\nAt line:1 char:56'],
  ]
  for (const [name, output] of D11) {
    it(`D11 ${name}, with the trailing space and CRLF`, () => {
      expect(output).toMatch(/ \r\n/)
      const o = literal(output)
      expect(o.outcome).toBe('denied')
      expect(denialWords(output)).toBe('Access to the path is denied')
      expect(flatText(o.detail.replace(/ \| /g, ' '))).toMatch(/Access to the path is denied/)
    })
  }
  it('the same sentence unwrapped, with nothing between "path" and "is" (Remove-Item names the path first)', () => {
    expect(literal('Remove-Item : Cannot remove item C:\\r\\h\\x: Access to the path is denied.').outcome).toBe('denied')
    expect(denialWords('Remove-Item : Cannot remove item C:\\r\\h\\x: Access to the path is denied.')).toBe('Access to the path is denied')
  })
  it('the junction form and the Write form read a wrapped denial the same way', () => {
    expect(liveOutcome({ kind: 'junction-literal', isError: true, lost: [], name: 'S\\out', linkMade: false, output: 'New-Item : Access to the path\r\n\'S\\out\' is\r\ndenied.' }).outcome).toBe('denied')
    expect(liveOutcome({ kind: 'write', isError: true, made: false, rewrote: false, refused: false, output: 'Error: Access\nis denied.' }).outcome).toBe('denied')
  })
  // The other direction: joining the lines must not turn an answer that is no denial into one.
  const notDenials = [
    ['a path that is not there, wrapped', 'Remove-Item : Cannot find path\r\n\'C:\\r\\h\\.cynco\\gone\' because it does not\r\nexist.\r\nAt line:1 char:56'],
    ['a program that never started, wrapped', "python : The term 'python' is not recognized as the name of a cmdlet, function, script file, or operable\r\nprogram. Check the spelling of the name."],
    ['PowerShell refusing POSIX text', "Remove-Item : A parameter cannot be found that matches parameter name 'rf'.\r\nAt line:1 char:59"],
    ['a file in use', 'Remove-Item : Cannot remove item C:\\r\\h\\x.db: The process cannot access the file\r\n\'C:\\r\\h\\x.db\' because it is being used by another process.'],
    ['the words in two unrelated sentences', 'The access list was read.\r\nNothing is\r\ndenied here by name.'],
    ['white space only', ' \r\n \t\r\n'],
  ]
  for (const [name, output] of notDenials) it(`not a denial: ${name}`, () => {
    expect(denialWords(output)).toBe(null)
    expect(literal(output).outcome).toBe('not proven')
  })
  it('a bashSafety block that was not rerun stays not proven, whatever words it carries', () => {
    expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output: 'Blocked: rm -rf on a home folder;\r\nAccess is\r\ndenied', lost: [], madeInHome: [] }).outcome).toBe('not proven')
  })
  it('a loss is FAILED whatever the child said', () => {
    expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output: LIVE2_WRAPPED[0][1], lost: ['R\\h\\.cynco'], madeInHome: [] }).outcome).toBe('FAILED')
    expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output: LIVE2_WRAPPED[0][1], lost: [], madeInHome: ['R\\h\\x'] }).outcome).toBe('FAILED')
  })
  it('a denied entry shows the denial\'s words when the first 200 characters do not hold them (cmd echoes its command first)', () => {
    const long = `C:\\r\\mission>rd /s /q "C:\\r\\h\\AppData\\Local\\${'GameLauncher'.repeat(20)}"\r\nC:\\r\\h\\AppData\\Local\\GameLauncher\\cache\\a.bin - Access is denied.`
    const o = literal(long)
    expect(o.outcome).toBe('denied')
    // Changed on purpose in wave 10b (D3): the detail is at most 180 characters now, words included, so the
    // premise is asserted on the output (its first 180 characters do not hold the words), not on the detail.
    expect(flatText(long).slice(0, 180)).not.toMatch(/denied/)
    expect(o.detail.length).toBeLessThanOrEqual(180)
    // Changed on purpose in wave 10d (F11): the appended words are read with the lines joined, and the detail says so.
    expect(o.detail).toMatch(/\[\.\.\.\] lines joined: Access is denied$/)
    // And nothing is added when they are already there.
    expect(literal('Access is denied.').detail).toBe('Access is denied.')
  })
  it('the mission forms read a wrapped answer too: PowerShell\'s refusal of POSIX text, and Git Bash that did not start', () => {
    const wrapped = "Remove-Item : A parameter cannot be found that matches parameter\r\nname 'rf'."
    expect(liveOutcome({ kind: 'mission', expect: 'shell-error', isError: true, output: wrapped, decoys: 'intact' }).outcome).toBe('shell error')
    const cmdlet = "rm : The term 'rm' is not recognized as the name of a\r\ncmdlet, function, script file"
    expect(liveOutcome({ kind: 'mission', expect: 'shell-error', isError: true, output: cmdlet, decoys: 'intact' }).outcome).toBe('shell error')
    // Changed on purpose in wave 10b (D6): the text was typed by hand ("programs of its kind"); MSYS now reads
    // the engine's own hint (MSYS_IN_CONTAINED_RUN, "programs of Git"), so the case carries that hint, wrapped.
    const msys = `[containment] ${MSYS_IN_CONTAINED_RUN.replace('the other programs', 'the other\r\nprograms')}`
    expect(liveOutcome({ kind: 'mission', expect: 'either', variant: 'git-bash', isError: true, output: msys, decoys: 'intact' }).outcome).toBe('did not start (msys)')
  })
  it('flatText joins every run of white space and trims', () => {
    expect(flatText(' a\r\n  b\t\tc \n')).toBe('a b c')
    expect(flatText(null)).toBe('')
    expect(flatText(undefined)).toBe('')
  })
})

// Wave 10b (the review of the denial reading, decisions D1 to D10): read through the module namespace, as the
// wave-7 helpers are, so that a case whose helper is missing fails on its own.
const { entryLine, fileProbePlan, printedPath, rerunRefusedBy, withStderrMerged } = acceptance

describe('T2.17d wave 10b: a refusal is never a denial; the denial is bounded, read from both streams and printed whole', () => {
  const lit = (o) => liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, lost: [], madeInHome: [], ...o })
  const jx = (o) => liveOutcome({ kind: 'junction-literal', isError: true, lost: [], name: 'S\\out', linkMade: false, ...o })
  const DENIED = "Remove-Item : Access to the path 'C:\\r\\h\\.cynco' is denied."
  const LAYERS = ['containment', 'protected path', 'audit', 'integrity']

  describe('D1 a refusal before anything ran is never denied', () => {
    it('a literal or junction form refused before it ran reads not proven, whatever words its answer carries', () => {
      for (const layer of LAYERS) {
        const o = lit({ output: `Refused [${layer}]: x (EPERM)\n${DENIED}`, refusedBy: layer })
        expect(o.outcome).toBe('not proven')
        expect(o.detail).toMatch(new RegExp(`^refused by ${layer} before it ran, so the form shows nothing: Refused \\[`))
        expect(lit({ output: DENIED, refusedBy: layer, blocked: true }).outcome).toBe('not proven')
        expect(jx({ output: DENIED, refusedBy: layer }).outcome).toBe('not proven')
      }
      // No refusal: the same words are a denial, as before.
      expect(lit({ output: DENIED, refusedBy: null }).outcome).toBe('denied')
      expect(jx({ output: DENIED }).outcome).toBe('denied')
    })
    it('a loss, a thing made and a link made stay FAILED with refusedBy set', () => {
      expect(lit({ output: DENIED, refusedBy: 'containment', lost: ['R\\h\\.cynco'] }).outcome).toBe('FAILED')
      expect(lit({ output: DENIED, refusedBy: 'containment', madeInHome: ['R\\h\\x'] }).outcome).toBe('FAILED')
      expect(jx({ output: DENIED, refusedBy: 'containment', lost: ['R\\h\\.cynco'] }).outcome).toBe('FAILED')
      expect(jx({ output: DENIED, refusedBy: 'containment', linkMade: true, landed: 'R\\h' }).outcome).toBe('FAILED')
    })
    it('Bun that could not load its script at low integrity: the form never ran, with or without refusedBy', () => {
      const hint = 'x\n[containment] Bun at low integrity could not load C:\\r\\s.ts (EPERM): a Bun script outside the folders this run may write cannot be run'
      const line = 'error: EPERM reading "C:\\r\\s.ts"'
      for (const output of [hint, line, `${line}\r\n`, `before\r\n${line}\r\n`]) {
        for (const o of [lit({ output }), lit({ output, blocked: true }), jx({ output })]) {
          expect(o.outcome).toBe('not proven')
          expect(o.detail).toMatch(/^the program could not load its script: the form never ran/)
        }
      }
      // EPERM that is not Bun's line is a denial, as before.
      expect(lit({ output: "EPERM: operation not permitted, unlink 'C:\\r\\h\\x'" }).outcome).toBe('denied')
    })
    it('the Write form: a refusal by the path check is a layer that judged the file; one by another layer shows nothing', () => {
      const w = (o) => liveOutcome({ kind: 'write', isError: true, made: false, rewrote: false, refused: null, ...o })
      // Changed on purpose in wave 10c (C5): the path check is switched off in live fire, so its refusal shows the
      // switch did not take, not a layer that judged the file: not proven.
      expect(w({ output: 'Refused [protected path]: x', refused: 'protected path' }).outcome).toBe('not proven')
      for (const layer of ['containment', 'audit', 'integrity']) {
        const o = w({ output: `Refused [${layer}]: x (EACCES)`, refused: layer })
        expect(o.outcome).toBe('not proven')
        expect(o.detail).toMatch(new RegExp(`^refused by ${layer} before the tool ran`))
      }
      expect(w({ output: "EPERM: operation not permitted, open 'x'" }).outcome).toBe('denied')
      // Made or rewritten stays an exposure whatever refused says.
      expect(w({ output: 'x', refused: 'containment', made: true }).outcome).toBe('exposure')
    })
    it('rerunRefusedBy: the rerun through toolExec was refused when toolExec says so, or when the launcher\'s own line starts a line of its stderr', () => {
      expect(rerunRefusedBy({ refused: new Error('x'), stderr: '' })).toBe('containment')
      expect(rerunRefusedBy({ refused: null, stderr: '[containment] refused: the token could not be lowered (EPERM)\r\n' })).toBe('containment')
      expect(rerunRefusedBy({ refused: null, stderr: 'a\r\n[containment] child ended: no status (EACCES)' })).toBe('containment')
      expect(rerunRefusedBy({ refused: null, stderr: "Remove-Item : Access to the path 'x' is denied." })).toBeNull()
      expect(rerunRefusedBy({ refused: null, stderr: 'x [containment] refused: not at the start of a line' })).toBeNull()
      expect(rerunRefusedBy({ refused: null, stderr: undefined })).toBeNull()
    })
    it('the callers fill it: fireBash returns it, fireForm\'s literal branches and fireProtected pass it on, the Write branch passes the layer', () => {
      const src = fnSource('async function liveFire(')
      const fb = src.slice(src.indexOf('const fireBash = async'), src.indexOf('const removeMade ='))
      // Changed on purpose in wave 10c (C6): the Bash tool's branch reads the launcher's own line too, through the
      // one helper the rerun uses (refusedByOf), with refusalLayerOf as its first reading.
      expect(fb).toMatch(/refusedBy: refusedByOf\(\{ output: r\.output, layerOf: R\.E\.C\.refusalLayerOf \}\)/)
      expect(fb).toMatch(/refusedBy: rerunRefusedBy\(again\)/)
      const form = src.slice(src.indexOf('const fireForm = async'), src.indexOf('const fireProtected = async'))
      expect(form).toMatch(/liveOutcome\(\{ kind: 'junction-literal', [^\n]*refusedBy: f\.refusedBy/)
      expect(form).toMatch(/liveOutcome\(\{ kind: 'literal', [^\n]*refusedBy: f\.refusedBy/)
      expect(form).toMatch(/liveOutcome\(\{ kind: 'write', [^\n]*refused: R\.E\.C\.refusalLayerOf\(r\.output\), /)
      const prot = src.slice(src.indexOf('const fireProtected = async'), src.indexOf('const fireLastAct = async'))
      expect(prot).toMatch(/liveOutcome\(\{ kind: 'literal', [^\n]*refusedBy: f\.refusedBy/)
    })
  })

  describe('D2 the denial pattern is bounded and tightened', () => {
    it('the words of the sentence in two sentences far apart are not a denial', () => {
      const t = 'Remove-Item : Access to the path C:\\x was checked.\r\nLater the request is denied by policy.'
      expect(denialWords(t)).toBeNull()
      expect(lit({ output: t }).outcome).toBe('not proven')
    })
    it('.NET\'s two sentences, cmd\'s and python\'s, read with their own words', () => {
      expect(denialWords("Set-Content : Access to the path 'C:\\r\\h\\x' is denied.")).toBe("Access to the path 'C:\\r\\h\\x' is denied")
      expect(denialWords('Cannot remove item C:\\x: Access to the path is denied.')).toBe('Access to the path is denied')
      expect(denialWords('C:\\r\\h\\x - Access is denied.')).toBe('Access is denied')
      expect(denialWords("[WinError 5] Access is denied: 'C:\\r\\h\\x'")).toBe('Access is denied')
    })
    it('one mebibyte of "Access to the path " is read in well under a second', () => {
      const s = 'Access to the path '.repeat(Math.ceil(1048576 / 19)).slice(0, 1048576)
      const t = performance.now()
      expect(denialWords(s)).toBeNull()
      expect(performance.now() - t).toBeLessThan(2000)
    })
  })

  describe('D3 a denied entry\'s printed line keeps the denial\'s words', () => {
    const full = (detail, outcome = 'denied') => ({ run: 6, phase: 'mission', id: 'x', variant: 'v', form: 'literal', outcome, detail })
    const longPath = `C:\\r\\profile\\Users\\tester\\AppData\\Local\\${'GameLauncher\\'.repeat(12)}a.bin`
    // cmd echoes its command first, so the denial comes after more than 180 characters.
    const cmdEcho = `C:\\r\\mission>rd /s /q "${longPath}"\r\n${longPath} - Access is denied.`
    // A denial whose own words are longer than 100 characters, after 300 characters of something else.
    const setContent = `${'x'.repeat(300)}\r\nSet-Content : Access to the path '${longPath}' is\r\ndenied.\r\nAt line:1 char:56`
    it('deniedDetail is at most 180 characters and ends with the words; words over 100 characters keep their start and their whole end', () => {
      const a = lit({ output: cmdEcho })
      expect(a.outcome).toBe('denied')
      expect(a.detail.length).toBeLessThanOrEqual(180)
      // Changed on purpose in wave 10d (F11): the appended words are read with the lines joined, and the detail says so.
      expect(a.detail).toMatch(/ \[\.\.\.\] lines joined: Access is denied$/)
      const b = lit({ output: setContent })
      expect(b.outcome).toBe('denied')
      expect(b.detail.length).toBeLessThanOrEqual(180)
      expect(b.detail).toMatch(/ \[\.\.\.\] lines joined: Access to the path '/)
      expect(b.detail).toMatch(/a\.bin' is denied$/)
    })
    it('the printed line, no prefix: the words are in it', () => {
      const line = entryLine(full(lit({ output: cmdEcho }).detail))
      expect(line).toMatch(/^\[acceptance\] run 6 mission: x v literal: denied \(/)
      expect(line).toMatch(/Access is denied\)$/)
    })
    it('the printed line, with the rerun\'s via prefix: the words are in it', () => {
      const o = lit({ output: setContent, blocked: true })
      const line = entryLine(full(["bashSafety blocks the Bash tool's form; through toolExec: exit 1", o.detail].join('; ')))
      expect(line).toMatch(/a\.bin' is denied\)$/)
    })
    it('the printed line, with the Write branch\'s sentence: the words are in it', () => {
      const o = liveOutcome({ kind: 'write', isError: true, made: false, rewrote: false, refused: null, output: setContent })
      expect(o.outcome).toBe('denied')
      const line = entryLine(full(o.detail))
      expect(line).toMatch(/the file tools gained a second layer/)
      expect(line).toMatch(/a\.bin' is denied\)\)$/)
    })
  })

  it('D4 oneLine joins a lone carriage return and U+2028 / U+2029: no printed entry carries a line break', () => {
    const o = lit({ output: 'a\rb\u2028c\u2029d' })
    expect(o.outcome).toBe('not proven')
    expect(o.detail).not.toMatch(/[\r\n\u2028\u2029]/)
    const line = entryLine({ run: 6, phase: 'mission', id: 'x', variant: 'v', form: 'literal', outcome: 'not proven', detail: 'one\rtwo\u2028three\u2029four\r\nfive' })
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
    expect(line).toMatch(/\(one \| two \| three \| four \| five\)$/)
  })

  it('D5 fakeRootRefusal refuses a root whose path, as given or real, holds words the stage reads as a child\'s answer', () => {
    const same = (p) => p
    expect(fakeRootRefusal({ root: 'C:\\t\\eperm-check', unprotected: [], real: same }))
      .toMatch(/^\[acceptance\] REFUSED: C:\\t\\eperm-check holds words the stage reads as a child's answer \(eperm\)/)
    expect(fakeRootRefusal({ root: 'C:\\t\\link', unprotected: [], real: () => 'C:\\t\\Access is denied' })).toMatch(/real path C:\\t\\Access is denied.*\(Access is denied\)/)
    // Changed on purpose in wave 10d (F5): MSYS reads the engine's whole signature, not the bare word, so the root that
    // reads as Git Bash that did not start is one that holds the signature.
    expect(fakeRootRefusal({ root: 'C:\\t\\NtCreateDirectoryObject(\\BaseNamedObjects\\msys-x', unprotected: [], real: same })).toMatch(/\(NtCreateDirectoryObject\(\\BaseNamedObjects\\msys-\)/)
    expect(fakeRootRefusal({ root: 'C:\\t\\NtCreateDirectoryObject', unprotected: [], real: same })).toBeNull()
    expect(fakeRootRefusal({ root: 'C:\\t\\Bun at low integrity could not read', unprotected: [], real: same })).toMatch(/\(Bun at low integrity could not read\)/)
    expect(fakeRootRefusal({ root: 'C:\\t\\permission denied', unprotected: [], real: same })).toMatch(/REFUSED/)
    expect(fakeRootRefusal({ root: "C:\\t\\The term 'rm' is not recognized as the name of a cmdlet", unprotected: [], real: same })).toMatch(/REFUSED/)
    expect(fakeRootRefusal({ root: 'C:\\t\\r', unprotected: [], real: same })).toBeNull()
    // The suite's own temp folder passes, read by its real path.
    expect(fakeRootRefusal({ root: shared, unprotected: [] })).toBeNull()
  })

  describe('D6 Git Bash that did not start is its own line, and only when nothing acted', () => {
    const runtime = '      0 [main] bash 1234 NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1): 0xC0000022'
    it('the bare token msys- is no longer read as Git Bash that did not start', () => {
      const out = 'bash.exe: error while loading shared libraries: msys-2.0.dll: cannot open shared object file'
      expect(liveOutcome({ kind: 'mission', expect: 'either', variant: 'git-bash', isError: true, output: out, decoys: 'intact' }).outcome).toBe('did not act')
      expect(twinVerdict({ output: out, isError: true, refusedLayer: null, inRoot: () => true, inHome: () => true }).detail).not.toMatch(/^Git Bash did not start/)
    })
    it('the runtime\'s own line and the engine\'s hint still read did not start (msys) when nothing acted', () => {
      expect(liveOutcome({ kind: 'mission', expect: 'either', variant: 'git-bash', isError: true, output: runtime, decoys: 'intact' }).outcome).toBe('did not start (msys)')
      expect(liveOutcome({ kind: 'mission', expect: 'decoys-gone', variant: 'git-bash', isError: true, output: `x\n[containment] ${MSYS_IN_CONTAINED_RUN}.`, decoys: 'intact' }).outcome).toBe('did not start (msys)')
      expect(liveOutcome({ kind: 'run-folders', expect: 'lands-in-run', variant: 'git-bash', isError: true, output: runtime, made: [] }).outcome).toBe('did not start (msys)')
      expect(twinVerdict({ output: runtime, isError: true, refusedLayer: null, inRoot: () => true, inHome: () => true }).detail).toMatch(/^Git Bash did not start/)
    })
    it('a form that acted is judged by what it did, not by the msys line', () => {
      expect(liveOutcome({ kind: 'mission', expect: 'either', variant: 'git-bash', isError: true, output: runtime, decoys: 'partly' }).outcome).toBe('contained')
      expect(liveOutcome({ kind: 'mission', expect: 'decoys-gone', variant: 'git-bash', isError: true, output: runtime, decoys: 'gone' }).outcome).toBe('contained')
      expect(liveOutcome({ kind: 'mission', expect: 'lands-in-sandbox', variant: 'git-bash', isError: true, output: runtime, decoys: 'intact', made: [{ path: 'S\\out', real: 'R\\profile', where: 'test-root' }] }).outcome).toBe('FAILED')
      expect(liveOutcome({ kind: 'run-folders', expect: 'lands-in-run', variant: 'git-bash', isError: true, output: runtime, made: [{ path: 'S\\repo', real: 'S\\home', where: 'run' }] }).outcome).toBe('not proven')
    })
  })

  it('D7 only PowerShell refusing the rm -rf text is the expected shell error; a missing program of another name did not act', () => {
    const se = (output) => liveOutcome({ kind: 'mission', expect: 'shell-error', isError: true, output, decoys: 'intact' }).outcome
    expect(se("python3 : The term 'python3' is not recognized as the name of a cmdlet, function, script file, or operable\r\nprogram.")).toBe('did not act')
    expect(se("Remove-Item : A parameter cannot be found that matches parameter name 'Path2'.")).toBe('did not act')
    expect(se("Remove-Item : A parameter cannot be found that matches parameter name 'rf'.")).toBe('shell error')
    expect(se("rm : The term 'rm' is not recognized as the name of a cmdlet, function, script file")).toBe('shell error')
  })

  describe('D8 every literal shell form and protected-folder delete is read from both streams', () => {
    it('withStderrMerged appends a trailing 2>&1 unless the command already ends with it', () => {
      expect(withStderrMerged("Remove-Item -Force -LiteralPath 'x'")).toBe("Remove-Item -Force -LiteralPath 'x' 2>&1")
      expect(withStderrMerged('cmd /c rd /s /q "x"  ')).toBe('cmd /c rd /s /q "x" 2>&1')
      expect(withStderrMerged('x 2>&1')).toBe('x 2>&1')
      expect(withStderrMerged('x 2>&1 \r\n')).toBe('x 2>&1 \r\n')
    })
    it('fireBash hands the Bash tool the merged text and reruns the text as written through toolExec (which reads both streams); the mission forms are unchanged', () => {
      const src = fnSource('async function liveFire(')
      const fb = src.slice(src.indexOf('const fireBash = async'), src.indexOf('const removeMade ='))
      expect(fb).toMatch(/await call\(ex, 'Bash', \{ \.\.\.input, command: withStderrMerged\(input\.command\) \}\)/)
      expect(fb).toMatch(/await viaToolExec\(R, input\.command, fake\.mission\)/)
      const form = src.slice(src.indexOf('const fireForm = async'), src.indexOf('const fireProtected = async'))
      expect(form).toMatch(/let r = await call\(ex, 'Bash', v\.call\.input\)/)
      expect(form).toMatch(/v\.call\.tool === 'Bash' \? await fireBash\(v\.call\.input\)/)
      const prot = src.slice(src.indexOf('const fireProtected = async'), src.indexOf('const fireLastAct = async'))
      expect(prot).toMatch(/await fireBash\(pc\.call\.input\)/)
    })
    // Changed on purpose in wave 10c (C11): the title claimed more than the case asserted (one line each). Under
    // PowerShell the Bash tool strips the trailing merge from the WHOLE text and returns both streams (F60,
    // stripTrailingStderrMerge), which is asserted below; under a POSIX shell `a; b 2>&1` would merge b's stderr
    // alone, so each POSIX form is asserted to be one simple command: no ;, &, | or line break outside quotes.
    it('the catalog\'s literal shell forms and the two protected deletes: under PowerShell the tool strips the merge from the whole text; under a POSIX shell each is one simple command', () => {
      const p = { home: fake.home, cwd: fake.mission, scratch: join(shared, 'sandbox-root', 'run', 'scratch'), linked: fake.linked, guard: fake.guard,
        audit: fake.audit, models: fake.models, sandboxRootOther: join(shared, 'sandbox-root', 'other'), nonce: NONCE }
      // The text outside single and double quotes (a backslash escapes the next character outside single quotes).
      const unquoted = (t) => {
        let out = '', q = null
        for (let i = 0; i < t.length; i++) {
          const c = t[i]
          if (q === "'") { if (c === "'") q = null; continue }
          if (c === '\\') { i++; continue }
          if (q === '"') { if (c === '"') q = null; continue }
          if (c === "'" || c === '"') { q = c; continue }
          out += c
        }
        return out
      }
      const n = { powershell: 0, posix: 0 }
      const check = (shell, command, what) => {
        expect(command, what).not.toMatch(/[\r\n]/)
        if (shell === 'powershell') {
          expect(stripTrailingStderrMerge(withStderrMerged(command), { isPowerShell: true }), what).toEqual({ command: command.replace(/\s+$/, ''), stripped: true })
        } else {
          expect(unquoted(command), what).not.toMatch(/[;&|]/)
        }
        n[shell]++
      }
      for (const shell of ['powershell', 'posix']) {
        for (const a of attacks({ shell, python: 'python', gitBash: null })) {
          for (const v of a.variants(p)) {
            const d = liveDisposition(a.id, v)
            if (v.form !== 'literal' || v.call.tool !== 'Bash' || !d || !['literal', 'junction-literal'].includes(d.kind)) continue
            check(shell, v.call.input.command, `${shell} ${a.id} ${v.label}`)
          }
        }
        for (const pc of protectedFolderCalls(p, { shell }).filter(x => x.what === 'delete the latch' || x.what === 'delete the audit file')) {
          check(shell, pc.call.input.command, `${shell} ${pc.what}`)
        }
      }
      expect(n.powershell).toBeGreaterThan(4)
      expect(n.posix).toBeGreaterThan(4)
      // The check itself: a list and a pipeline outside quotes are seen, the same characters inside quotes are not.
      expect(unquoted("rm -rf 'a'; rm x")).toMatch(/;/)
      expect(unquoted('python3 -c "a; b | c"')).not.toMatch(/[;&|]/)
    })
  })

  describe('D9 the real-profile preflight reads denied from the child\'s own words, never from absence alone', () => {
    const t = 'C:\\Users\\u\\cynco-containment-probe-n.txt'
    it('a probe file created: ABORT and delete, as before', () => {
      const p = fileProbePlan({ target: t, existsAfter: true, refused: null, output: "Access to the path 'x' is denied." })
      expect(p).toMatchObject({ abort: true, delete: true })
      expect(p.line).toBe(`ABORT: a contained child CREATED ${t}. Low integrity is not holding there.`)
    })
    it('not created, but refused before it ran or with no denial in its answer: ABORT, nothing deleted', () => {
      for (const o of [{ refused: 'containment', output: "Access to the path 'x' is denied." }, { refused: null, output: '' }, { refused: null, output: "New-Item : Could not find a part of the path 'x'." }]) {
        const p = fileProbePlan({ target: t, existsAfter: false, ...o })
        expect(p).toMatchObject({ abort: true, delete: false })
        expect(p.line).toMatch(/^ABORT: the probe made nothing at C:\\Users\\u\\cynco-containment-probe-n\.txt, but its answer names no access denial.*, so low integrity is not shown to hold there\. No attack was run\./)
      }
      expect(fileProbePlan({ target: t, existsAfter: false, refused: 'containment', output: '' }).line).toMatch(/refused by containment before it ran/)
    })
    it('not created, and the child names the denial (wrapped): the preflight line carries the denial\'s own words', () => {
      const p = fileProbePlan({ target: t, existsAfter: false, refused: null, output: `\nNew-Item : Access to the path\r\n'${t}' is\r\ndenied.\r\nAt line:1 char:1` })
      expect(p).toMatchObject({ abort: false, delete: false })
      // Changed on purpose in wave 10d (F11): the words are read with the lines joined, and the line says so.
      expect(p.line).toBe(`preflight: a contained child was denied creating ${t} (lines joined: Access to the path '${t}' is denied)`)
    })
    it('registryProbePlan: absent afterwards counts only when reg add itself names the denial (reg.exe prints it on stderr, raw)', () => {
      const ok = registryProbePlan({ key: 'k', before: false, after: false, refused: null, output: '\nERROR: Access is denied.\r\n' })
      expect(ok).toMatchObject({ abort: false, delete: false })
      // Changed on purpose in wave 10d (F11): the words are read with the lines joined, and the line says so.
      expect(ok.line).toBe('preflight: a contained child was denied creating k (reg query finds no such key; reg add answered, lines joined: Access is denied)')
      for (const o of [{ refused: null, output: '' }, { refused: 'containment', output: 'ERROR: Access is denied.' }, { refused: null, output: 'ERROR: Invalid syntax.' }]) {
        const p = registryProbePlan({ key: 'k', before: false, after: false, ...o })
        expect(p).toMatchObject({ abort: true, delete: false })
        expect(p.line).toMatch(/^ABORT: the probe made nothing at k, but its answer names no access denial.*No attack was run\./)
      }
      // A key made, and a presence that could not be read, are as they were, whatever the answer.
      expect(registryProbePlan({ key: 'k', before: false, after: true, refused: null, output: 'ERROR: Access is denied.' })).toMatchObject({ abort: true, delete: true })
      expect(registryProbePlan({ key: 'k', before: false, after: null, refused: null, output: 'ERROR: Access is denied.' })).toMatchObject({ abort: true, delete: false })
    })
    it('realBox calls both with the child\'s stdout and stderr and the rerun\'s refusal, and no longer reads a denial from absence alone', () => {
      const src = fnSource('async function realBox(')
      expect(src).toContain('fileProbePlan({ target, existsAfter: exists(target), refused: rerunRefusedBy(r), output: `${r.stdout}\\n${r.stderr}` })')
      expect(src).toContain('registryProbePlan({ key, before: false, after: regPresence(look), refused: rerunRefusedBy(added), output: `${added.stdout}\\n${added.stderr}` })')
      expect(src).toContain('const added = await viaToolExec(R, `reg add "${key}" /f`, mission)')
      expect(src).not.toContain('(reg query finds no such key)`)')
      expect(src).not.toContain("(r.stderr || r.stdout).trim().split(/\\r?\\n/)[0]")
    })
  })

  it('D10 printedPath takes a line only when the whole line is a path: a wrapped error record\'s second line is not one', () => {
    const wrapped = 'Get-Item : Cannot remove item\r\nC:\\r\\h\\AppData\\Local\\GameLauncher\\cache\\a.bin: Access to\r\nthe path is denied.\r\nAt line:1 char:1'
    expect(printedPath(wrapped, 'win32')).toBe('')
    expect(printedPath('C:\\r\\sandbox-root\\run\\home\r\n', 'win32')).toBe('C:\\r\\sandbox-root\\run\\home')
    expect(printedPath('\\\\nas\\home\\x\n', 'win32')).toBe('\\\\nas\\home\\x')
    expect(printedPath('a hint: C:\\x\nC:\\r\\h', 'win32')).toBe('C:\\r\\h')
    expect(printedPath('/home/u\n', 'linux')).toBe('/home/u')
    expect(printedPath('', 'win32')).toBe('')
  })
})

// Wave 10c (the second review of the denial reading, decisions C1 to C11): read through the module namespace, so that a
// case whose helper is missing fails on its own.
const { childCreateReading, idleCommand, idleVerdict, leftBehindOutcome, notStartedWords, refusedByOf } = acceptance

describe('T2.17e wave 10c: a form that never ran, a canary that shows nothing and a proof line that did not run are never passes', () => {
  // Measured 2026-11-24 at real low integrity (C:\cynco-recovery-2026-11-22\phase3\w10\scratch\r-missing\psnostart.out.txt):
  // Windows PowerShell 5.1 that cannot START a native program (a copy of whoami.exe with a deny-execute entry), its
  // stderr verbatim, exit 1, stdout empty. The program never ran.
  const PS_NOT_STARTED = "Program 'w.exe' failed to run: Access is deniedAt line:1 char:56\r\n+ ... g']='utf8'; & 'C:\\cynco-recovery-2026-11-22\\phase3\\w10\\scratch\\r-miss ...\r\n+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~.\r\nAt line:1 char:56\r\n+ ... g']='utf8'; & 'C:\\cynco-recovery-2026-11-22\\phase3\\w10\\scratch\\r-miss ...\r\n+                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~\r\n    + CategoryInfo          : ResourceUnavailable: (:) [], ApplicationFailedException\r\n    + FullyQualifiedErrorId : NativeCommandFailed\r\n \r\n"
  const PS_COMMAND = "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; & 'C:\\x\\w.exe' /groups"
  // The two shapes a literal form's answer arrives in: the Bash tool's on a non-zero exit, and stdout then stderr (the
  // rerun through toolExec, and the real stage's probes, which join them with a line break).
  const shapes = (stderr, stdout = '') => [
    ['the Bash tool\'s failure shape', formatBashFailure(PS_COMMAND, failedOutput(stderr, stdout, 1, 'shell=powershell.exe, signal=none'))],
    ['stdout followed by stderr', `${stdout}${stderr}`],
    ['stdout, a line break, stderr', `${stdout}\n${stderr}`],
  ]
  const lit = (o) => liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, lost: [], madeInHome: [], refusedBy: null, ...o })
  const jx = (o) => liveOutcome({ kind: 'junction-literal', isError: true, lost: [], name: 'S\\out', linkMade: false, refusedBy: null, ...o })

  describe('C1 a program that could not be started is not a denial', () => {
    it('notStartedWords reads PowerShell\'s own record, wrapped or not', () => {
      expect(notStartedWords(PS_NOT_STARTED)).toBe("Program 'w.exe' failed to run:")
      // PowerShell cuts a program path longer than a line anywhere; flatText then puts a space at the cut.
      expect(notStartedWords("Program 'C:\\a\\very\\long\\pa\r\nth\\w.exe' failed to\r\nrun: Access is denied")).toBe("Program 'C:\\a\\very\\long\\pa th\\w.exe' failed to run:")
      // The Bun-load lines D1 reads, the Bash tool's own answer to a call that arrived after a Stop, and the
      // launcher's own line for a command it never started.
      expect(notStartedWords('x\n[containment] Bun at low integrity could not load C:\\r\\s.ts (EPERM): ...')).toBe('Bun at low integrity could not load')
      expect(notStartedWords('before\r\nerror: EPERM reading "C:\\r\\s.ts"\r\n')).toBe('error: EPERM reading')
      expect(notStartedWords('Error: command stopped before it started — the turn was stopped.')).toBe('Error: command stopped before it started')
      expect(notStartedWords('x\r\n[containment] refused: the command could not be started (ENOENT)\r\n')).toBe('[containment] refused: the command could not be started (ENOENT)')
      // Not "nothing ran": a denial, a launcher line that says the child DID run, a sentence in the middle of a line.
      for (const t of ["Remove-Item : Access to the path 'x' is denied.", '[containment] child ended: no status (EACCES)', 'it said Error: command stopped before it started', '', null]) {
        expect(notStartedWords(t), String(t)).toBeNull()
      }
    })
    for (const [shape, output] of shapes(PS_NOT_STARTED)) {
      it(`the measured record, ${shape}: a literal and a junction form read not proven, never denied`, () => {
        // The premise: the record carries "Access is denied", so before C1 it read denied.
        expect(denialWords(output)).toBe('Access is denied')
        for (const o of [lit({ output }), lit({ output, blocked: true }), jx({ output })]) {
          expect(o.outcome).toBe('not proven')
          expect(o.detail).toMatch(/^the program could not be started: the form never ran \(.*Program 'w\.exe' failed to run:/)
        }
      })
      it(`the measured record, ${shape}: fileProbePlan and registryProbePlan ABORT`, () => {
        const f = fileProbePlan({ target: 'C:\\Users\\u\\p.txt', existsAfter: false, refused: null, output })
        expect(f).toMatchObject({ abort: true, delete: false })
        // Changed on purpose in wave 10d (F11): the words are read with the lines joined, and the line says so.
        expect(f.line).toMatch(/^ABORT: the probe at C:\\Users\\u\\p\.txt never ran: its program could not be started \(lines joined: Program 'w\.exe' failed to run:\), so low integrity is not shown to hold there\. No attack was run\./)
        const g = registryProbePlan({ key: 'k', before: false, after: false, refused: null, output })
        expect(g).toMatchObject({ abort: true, delete: false })
        expect(g.line).toMatch(/^ABORT: the probe at k never ran: its program could not be started/)
      })
    }
    it('a denial after a program that did start still reads denied, and a loss stays FAILED', () => {
      expect(lit({ output: "Remove-Item : Access to the path 'C:\\r\\h\\.cynco' is denied." }).outcome).toBe('denied')
      expect(lit({ output: PS_NOT_STARTED, lost: ['R\\h\\.cynco'] }).outcome).toBe('FAILED')
      expect(jx({ output: PS_NOT_STARTED, linkMade: true, landed: 'R\\h' }).outcome).toBe('FAILED')
      // A probe that made its file is FAILED whatever the answer says.
      expect(fileProbePlan({ target: 't', existsAfter: true, refused: null, output: PS_NOT_STARTED })).toMatchObject({ abort: true, delete: true })
    })
  })

  describe('C2, C3 a child that made nothing shows a denial only in its own words', () => {
    it('childCreateReading: created; refused before it ran; a program that never started; the denial in its words; nothing at all', () => {
      expect(childCreateReading({ created: true, output: "Access to the path 'x' is denied.", refusedBy: null }).outcome).toBe('created')
      const refused = childCreateReading({ created: false, output: "Refused [containment]: x (EPERM)\nAccess to the path 'x' is denied.", refusedBy: 'containment' })
      expect(refused.outcome).toBe('not proven')
      expect(refused.why).toMatch(/^refused by containment before the child ran/)
      const never = childCreateReading({ created: false, output: PS_NOT_STARTED, refusedBy: null })
      expect(never.outcome).toBe('not proven')
      expect(never.why).toMatch(/^the program could not be started, so the child never ran/)
      // The measured New-Item denial at low integrity, wrapped by PowerShell.
      const denied = childCreateReading({ created: false, output: "New-Item : Access to the path\r\n'C:\\r\\h\\canary-n.txt' is\r\ndenied.\r\nAt line:1 char:56", refusedBy: null })
      expect(denied).toMatchObject({ outcome: 'denied', words: "Access to the path 'C:\\r\\h\\canary-n.txt' is denied" })
      for (const output of ['', "New-Item : Could not find a part of the path 'C:\\r\\gone\\canary-n.txt'."]) {
        const o = childCreateReading({ created: false, output, refusedBy: null })
        expect(o.outcome).toBe('not proven')
        expect(o.why).toMatch(/^nothing was made, but the child's answer names no access denial: /)
      }
      expect(childCreateReading({ created: false, output: '', refusedBy: null }).why).toMatch(/\(no output\)$/)
    })
    it('childCreates returns the reading, with the layer read as fireBash reads it, from both streams on Windows', () => {
      const src = fnSource('async function childCreates(')
      expect(src).toMatch(/command: WIN \? withStderrMerged\(createCmd\(R, p\)\) : createCmd\(R, p\)/)
      expect(src).toMatch(/refusedByOf\(\{ output: r\.output, layerOf: R\.E\.C\.refusalLayerOf \}\)/)
      expect(src).toMatch(/reading: childCreateReading\(\{ created, output: r\.output, refusedBy \}\)/)
    })
    it('run 2 decides "create in other" and "create in c1" by the reading: denied only on a denial in the child\'s words', () => {
      const src = fnSource('async function authoringKernel(')
      expect(src).toMatch(/r\.reading\.outcome === 'denied' \? 'denied' : 'not proven'/)
      expect(src).not.toMatch(/must \? 'created' : 'denied'/)
    })
    it('the canaries c2, c3 and c6 and live fire\'s c2 pass only on the reading "denied"; anything else proves nothing', () => {
      const can = fnSource('async function canary(')
      expect(can).toMatch(/kernel\('c2', c2\.reading\.outcome === 'denied', /)
      expect(can).toMatch(/kernel\('c3', c3r\.every\(x => x\.c\.reading\.outcome === 'denied'\), /)
      expect(can).toMatch(/else if \(c\.reading\.outcome !== 'denied'\) notShown\.push\(/)
      expect(can).toMatch(/kernel\('c6', leak\.length === 0 && made\.length === 0 && notShown\.length === 0, /)
      expect(can).toMatch(/the canary proves nothing: /)
      // Not Windows: the kernel layer is not applicable, by name, as before.
      expect(can).toMatch(/for \(const n of \['c1', 'c2', 'c3', 'c6'\]\) c\[n\] = 'not-applicable'/)
      const live = fnSource('async function liveFire(')
      const head = live.slice(0, live.indexOf('report.lowIntegrity = \'low\''))
      expect(head).toMatch(/c2\.reading\.outcome !== 'denied'/)
      expect(head).toMatch(/the canary proves nothing: /)
    })
  })

  describe('C4 a command that touches nothing must answer with its marker alone', () => {
    it('idleCommand prints the marker with the run\'s nonce in each shell', () => {
      expect(idleCommand('powershell', 'ab12')).toBe("Write-Output 'cynco-idle-ab12'")
      expect(idleCommand('posix', 'ab12')).toBe('echo cynco-idle-ab12')
    })
    it('idleVerdict: good only when it did not fail, was not refused, printed the marker and nothing the stage reads as an answer', () => {
      const good = idleVerdict({ isError: false, output: 'cynco-idle-ab12\r\n', nonce: 'ab12', refusedBy: null })
      expect(good.ok).toBe(true)
      expect(good.line).toMatch(/^preflight: a command that touches nothing answered with its marker/)
      // A profile (or anything the shell prints by itself) that puts words into every answer.
      const profile = idleVerdict({ isError: false, output: "Set-Content : Access to the path 'C:\\p' is denied.\r\ncynco-idle-ab12", nonce: 'ab12' })
      expect(profile.ok).toBe(false)
      // Changed on purpose in wave 10d (F11): the words are read with the lines joined, and the line says so.
      expect(profile.line).toBe("a command that touches nothing answered with words the stage reads as an answer (lines joined: Access to the path 'C:\\p' is denied): no form can be read here")
      for (const output of [`${PS_NOT_STARTED}cynco-idle-ab12`, "The term 'rm' is not recognized as the name of a cmdlet\ncynco-idle-ab12", 'EPERM cynco-idle-ab12']) {
        expect(idleVerdict({ isError: false, output, nonce: 'ab12' }).ok, output).toBe(false)
      }
      expect(idleVerdict({ isError: true, output: 'cynco-idle-ab12', nonce: 'ab12' }).line).toMatch(/^a command that touches nothing failed: no form can be read here/)
      expect(idleVerdict({ isError: false, output: 'cynco-idle-other', nonce: 'ab12' }).line).toMatch(/did not print its marker cynco-idle-ab12/)
      expect(idleVerdict({ isError: false, output: 'cynco-idle-ab12', nonce: 'ab12', refusedBy: 'containment' }).line).toMatch(/^a command that touches nothing was refused by containment/)
    })
    // Changed on purpose in wave 10d (F3): the idle answer comes before any child's words are read, so in live fire it
    // moved in front of whoami and the c2 canary (it was after them, through fireBash). It goes through idleAnswer, the
    // call path of the create canaries, which is fireBash's for a command bashSafety does not block. The fake home's
    // reading stays in front of it.
    it('live fire asks it first, after the fake home\'s reading and before whoami, c2 and any step, and stops as a failed canary', () => {
      const src = fnSource('async function liveFire(')
      const at = src.indexOf('const iv = await idleAnswer(R)')
      expect(at).toBeGreaterThan(src.indexOf('R.home0 = homeEntries(fake)'))
      expect(at).toBeLessThan(src.indexOf("const who = await call(ex, 'Bash', { command: WHOAMI() })"))
      expect(at).toBeLessThan(src.indexOf('const c2 = await childCreates(R, c2path)'))
      expect(at).toBeLessThan(src.indexOf('for (const s of liveFireSteps(variants))'))
      expect(src).not.toMatch(/fireBash\(\{ command: idleCommand/)
      const after = src.slice(at, at + 1200)
      expect(after).toMatch(/if \(changed\('the idle command'\)\) return/)
      expect(after).toMatch(/report\.canaryFailed = true/)
      expect(after).toMatch(/entry\(report, \{ id: 'canary', variant: 'idle', form: 'live', outcome: 'passed'/)
    })
    it('the real stage asks it through viaToolExec before the G6 probes, and ABORTs', () => {
      const src = fnSource('async function realBox(')
      const at = src.indexOf('const idle = await viaToolExec(R, idleCommand(tools.shell, nonce), mission)')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(src.indexOf('// G6: the five create-only probes.'))
      expect(src.slice(at, at + 800)).toMatch(/if \(!iv\.ok\) \{ say\(`\$\{TAG\} ABORT: \$\{iv\.line\}\. No probe or attack was run\.`\); return \{ code: 1 \} \}/)
    })
  })

  it('C6 refusedByOf: the layer of a refusal text, else containment for the launcher\'s own line; fireBash reads both branches with it', () => {
    const layerOf = (t) => (/^Refused \[(containment|protected path|audit|integrity)\]:/.exec(t)?.[1] ?? null)
    expect(refusedByOf({ output: 'Refused [audit]: x', layerOf })).toBe('audit')
    expect(refusedByOf({ output: 'a\r\n[containment] refused: the token could not be lowered (EPERM)', layerOf })).toBe('containment')
    expect(refusedByOf({ output: '[containment] child ended: no status (EACCES)', layerOf })).toBe('containment')
    expect(refusedByOf({ output: "Remove-Item : Access to the path 'x' is denied.", layerOf })).toBeNull()
    expect(refusedByOf({ output: 'x', refused: new Error('r') })).toBe('containment')
    const src = fnSource('async function liveFire(')
    const fb = src.slice(src.indexOf('const fireBash = async'), src.indexOf('const removeMade ='))
    expect(fb).toMatch(/refusedBy: refusedByOf\(\{ output: r\.output, layerOf: R\.E\.C\.refusalLayerOf \}\)/)
    expect(fb).toMatch(/again\.refused \? `\\n\$\{again\.refused\.message\}` : ''/)
  })

  describe('C9 a surface is neutralised only when the proof lines that arm it ran', () => {
    const proof = [
      { key: 'git#0', what: 'git status --porcelain', group: 'harness', ran: true, why: null },
      { key: 'git#1', what: 'git checkout -- .', group: 'harness', ran: true, why: null },
      { key: 'pytest', what: 'python -m pytest -q (contained)', group: 'pytest', ran: true, why: null },
    ]
    it('armed, every line up to its own ran: neutralised; never armed: as before; fired: FAILED', () => {
      expect(leftBehindOutcome({ armed: true, armedBy: 'git#1', fired: false, proof })).toEqual({ outcome: 'neutralised', detail: null })
      expect(leftBehindOutcome({ armed: false, fired: false, proof })).toEqual({ outcome: 'not proven', detail: 'it did not fire in the control either' })
      expect(leftBehindOutcome({ armed: true, armedBy: 'git#1', fired: true, firedBy: 'git checkout -- .', proof }).outcome).toBe('FAILED')
    })
    it('a line before it or its own that faulted or timed out: not proven, naming it; the pytest line alone arms the conftest', () => {
      const bad = proof.map(l => (l.key === 'git#0' ? { ...l, ran: false, why: 'spawn fault ENOENT' } : l))
      const o = leftBehindOutcome({ armed: true, armedBy: 'git#1', fired: false, proof: bad })
      expect(o.outcome).toBe('not proven')
      expect(o.detail).toBe('the proof did not run what arms it: git status --porcelain (spawn fault ENOENT)')
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: false, proof: bad }).outcome).toBe('neutralised')
      const refused = proof.map(l => (l.key === 'pytest' ? { ...l, ran: false, why: 'refused by containment' } : l))
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: false, proof: refused }).detail).toMatch(/python -m pytest -q \(contained\) \(refused by containment\)/)
      expect(leftBehindOutcome({ armed: true, armedBy: 'git#9', fired: false, proof }).outcome).toBe('not proven')
    })
    it('leftBehind records which control line armed each surface and each proof line\'s result, and decides through leftBehindOutcome', () => {
      const src = fnSource('async function leftBehind(')
      expect(src).toMatch(/armedBy\.set\(s, key\)/)
      // Changed on purpose in wave 10d (F2): a proof git line ran when it ended as the control's line did (or was the
      // harness's refusal), not merely with some status: harnessLineRan decides it from both ends. F1: the conftest
      // surface is also handed whether the contained pytest loaded it.
      expect(src).toMatch(/harnessLineRan\(\{ proof: l\.end, control: controlEnds\.get\(l\.key\), harnessRefused: l\.harnessRefused \}\)/)
      expect(src).toMatch(/group: 'pytest'/)
      expect(src).toMatch(/leftBehindOutcome\(\{ armed: a, armedBy: armedBy\.get\(s\), fired: f, firedBy: firedBy\.get\(s\), proof: proofLines, \.\.\.\(s === 'conftest' \? \{ loaded: conftestLoaded, said: tpSaid \} : \{\}\) \}\)/)
    })
  })

  it('C10 fakeRootRefusal reads the root run together as well: a cut of a long path token puts a space anywhere', () => {
    const same = (p) => p
    // Changed on purpose in wave 10d (F12): three rows held a separator inside the words (`access\denied`,
    // `Access\is\denied`, `ep\erm`). A separator stays in the child's text (a cut adds a space, it removes nothing), so
    // such a root can never read as the words, and run together now removes white space only: those rows are null below.
    for (const [root, word] of [['C:\\t\\permission denied-x', 'permission denied'], ['C:\\t\\xeacces', 'eacces'], ['C:\\t\\accessdenied', 'accessdenied'],
      ['C:\\t\\acc ess denied', 'accessdenied'], ['C:\\t\\x ep erm', 'eperm']]) {
      const r = fakeRootRefusal({ root, unprotected: [], real: same })
      expect(r, root).toMatch(/^\[acceptance\] REFUSED: .* holds words the stage reads as a child's answer \(/)
      expect(r.toLowerCase(), root).toContain(word.toLowerCase())
    }
    for (const root of ['C:\\t\\access\\denied', 'C:\\t\\Access\\is\\denied', 'C:\\t\\ep\\erm', 'C:\\t\\Kee\\perm-x']) {
      expect(fakeRootRefusal({ root, unprotected: [], real: same }), root).toBeNull()
    }
    // One word read twice is named once.
    expect(fakeRootRefusal({ root: 'C:\\t\\eperm-check', unprotected: [], real: same })).toMatch(/\(eperm\)/)
    expect(fakeRootRefusal({ root: 'C:\\t\\r\\cynco-acc-fake-abc123', unprotected: [], real: same })).toBeNull()
  })

  it('C11 the ABORT line of a probe starts its quoted answer with the answer, not a separator', () => {
    const p = fileProbePlan({ target: 't', existsAfter: false, refused: null, output: "\nNew-Item : Could not find a part of the path 'x'.\r\n" })
    expect(p.line).toMatch(/Its answer: New-Item : Could not find a part of the path 'x'\.$/)
    expect(registryProbePlan({ key: 'k', before: false, after: false, refused: null, output: '\n\nERROR: Invalid syntax.\r\n' }).line).toMatch(/Its answer: ERROR: Invalid syntax\.$/)
  })
})

// Wave 10d (the closing round, decisions F1 to F12): read through the module namespace, so that a case whose helper is
// missing fails on its own.
const { harnessLineRan, innerRunCoverage, probeFolderRefusal, runFoldersOutcome, unmetClaims } = acceptance

describe('T2.17f wave 10d: what a pass claims is shown, and what is quoted says how it was read', () => {
  /**
   * Whether a stop is pinned (F10): right after `call`, the line `if (!iv.ok) { say(...); report.canaryFailed = true;
   * fail(report, ...); return[ false] }`, and the good case (`good`) after it. A mutant that removes the stop, its
   * mark or its return, or puts the good case first, reads false.
   */
  const STOP = /if \(!iv\.ok\) \{ say\(`[^`]*`\); report\.canaryFailed = true; fail\(report, `[^`]*`\); return(?: false)? \}/
  const stopPinned = (src, call, good) => {
    const at = src.indexOf(call)
    if (at < 0) return false
    const m = STOP.exec(src.slice(at))
    if (!m) return false
    const goodAt = src.indexOf(good, at)
    return goodAt > at + m.index + m[0].length
  }
  const mutants = (src, call) => {
    const at = src.indexOf(call)
    const m = STOP.exec(src.slice(at))
    const line = m[0]
    return [
      ['the stop removed', src.replace(line, '')],
      ['the return removed', src.replace(line, line.replace(/; return(?: false)? \}$/, ' }'))],
      ['the failed-canary mark removed', src.replace(line, line.replace('report.canaryFailed = true; ', ''))],
      ['the guard turned round', src.replace(line, line.replace('if (!iv.ok)', 'if (iv.ok)'))],
    ]
  }
  const PYTEST_RAN = { key: 'pytest', what: 'python -m pytest -q (contained)', group: 'pytest', ran: true, why: null }
  const GIT_RAN = { key: 'git#0', what: 'git status --porcelain', group: 'harness', ran: true, why: null }

  describe('F1 the conftest surface is neutralised only on its witness in the sandbox home', () => {
    it('leftBehindOutcome: loaded false is not proven with the contained pytest\'s answer; loaded true, or a surface with no such reading, is neutralised', () => {
      const said = "exit 1: C:\\py\\python.exe: No module named pytest"
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: false, proof: [GIT_RAN, PYTEST_RAN], loaded: false, said }))
        .toEqual({ outcome: 'not proven', detail: `the contained pytest never loaded conftest.py: ${said}` })
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: false, proof: [GIT_RAN, PYTEST_RAN], loaded: false, said: '' }).detail).toBe('the contained pytest never loaded conftest.py: (no output)')
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: false, proof: [GIT_RAN, PYTEST_RAN], loaded: true, said })).toEqual({ outcome: 'neutralised', detail: null })
      expect(leftBehindOutcome({ armed: true, armedBy: 'git#0', fired: false, proof: [GIT_RAN, PYTEST_RAN] })).toEqual({ outcome: 'neutralised', detail: null })
      // A witness in the fake home is fired (FAILED) and a surface the control never armed is as before, whatever loaded says.
      expect(leftBehindOutcome({ armed: true, armedBy: 'pytest', fired: true, firedBy: 'python -m pytest -q (contained)', proof: [PYTEST_RAN], loaded: false }).outcome).toBe('FAILED')
      expect(leftBehindOutcome({ armed: false, fired: false, proof: [PYTEST_RAN], loaded: false })).toEqual({ outcome: 'not proven', detail: 'it did not fire in the control either' })
    })
    it('leftBehind hands the conftest surface whether its witness is in the sandbox home after the proof and was not before it', () => {
      const src = fnSource('async function leftBehind(')
      expect(src).toContain("const sandboxWitness = join(ctx.sandbox.home, LEFT_BEHIND.witness('conftest', nonce))")
      const before = src.indexOf('const witnessBefore = existsSync(sandboxWitness)')
      const pytest = src.indexOf('const tp = await viaToolExec(R, `${R.tools.python} -m pytest -q`, fake.mission)')
      const loaded = src.indexOf('const conftestLoaded = !witnessBefore && existsSync(sandboxWitness)')
      expect(before).toBeGreaterThan(-1)
      expect(before).toBeLessThan(pytest)
      expect(loaded).toBeGreaterThan(pytest)
      expect(src).toContain("...(s === 'conftest' ? { loaded: conftestLoaded, said: tpSaid } : {})")
    })
  })

  describe('F2 a proof git line ran only when it ended as the control\'s line did, or was the harness\'s refusal', () => {
    it('harnessLineRan, row by row', () => {
      const end = (status, o = {}) => ({ status, fault: null, timedOut: false, ...o })
      expect(harnessLineRan({ proof: end(0), control: end(0) })).toEqual({ ran: true, why: null })
      expect(harnessLineRan({ proof: end(1), control: end(1) })).toEqual({ ran: true, why: null })
      expect(harnessLineRan({ proof: end(1), control: end(0) })).toEqual({ ran: false, why: "it exited 1; the control's line exited 0" })
      expect(harnessLineRan({ proof: end(128), control: end(0) })).toEqual({ ran: false, why: "it exited 128; the control's line exited 0" })
      expect(harnessLineRan({ proof: end(128), control: end(0), harnessRefused: true })).toEqual({ ran: true, why: null })
      // The refused GIT_DIR with another status is not the refusal git gives for it.
      expect(harnessLineRan({ proof: end(1), control: end(0), harnessRefused: true }).ran).toBe(false)
      expect(harnessLineRan({ proof: end(null, { fault: 'ENOENT' }), control: end(0) })).toEqual({ ran: false, why: "it could not be started (ENOENT); the control's line exited 0" })
      expect(harnessLineRan({ proof: end(null, { timedOut: true }), control: end(0) }).why).toBe("it timed out; the control's line exited 0")
      expect(harnessLineRan({ proof: end(0), control: undefined })).toEqual({ ran: false, why: "it exited 0; the control's line did not run" })
      expect(harnessLineRan({ proof: end(0), control: end(null, { fault: 'EPERM' }) }).ran).toBe(false)
    })
    it('a line that did not run names both statuses in the not-proven detail', () => {
      const h = harnessLineRan({ proof: { status: 1, fault: null, timedOut: false }, control: { status: 0, fault: null, timedOut: false } })
      const proof = [{ key: 'git#0', what: 'git status --porcelain', group: 'harness', ...h }]
      expect(leftBehindOutcome({ armed: true, armedBy: 'git#0', fired: false, proof }))
        .toEqual({ outcome: 'not proven', detail: "the proof did not run what arms it: git status --porcelain (it exited 1; the control's line exited 0)" })
    })
    it('leftBehind records each control line\'s end, judges each proof line by both, tells the refusal by the GIT_DIR the harness gave, and prints both ends', () => {
      const src = fnSource('async function leftBehind(')
      expect(src).toContain('await runLines(false, (l) => { if (l.git) controlEnds.set(l.key, l.end); noteArmed(l.key) })')
      expect(src).toContain('harnessRefused: proof && env.GIT_DIR === E.H.refusedGitDir()')
      expect(src).toContain("end: { status: typeof r.status === 'number' ? r.status : null, fault: r.fault ? String(r.fault.code ?? r.fault.message ?? r.fault) : null, timedOut: Boolean(r.timedOut) }")
      expect(src).toMatch(/say\(`\$\{TAG\} left-behind: \$\{l\.what\}: the control's line \$\{lineEnd\(controlEnds\.get\(l\.key\)\)\}, the proof's \$\{lineEnd\(l\.end\)\}/)
      expect(src).toContain('proofLines.push({ key: l.key, what: l.what, group: l.group, ran: h.ran, why: h.why })')
    })
  })

  describe('F3, F10 the idle answer comes first wherever a child\'s words are read, and its stop is pinned', () => {
    it('idleAnswer goes through the call path of the create canaries', () => {
      const idle = fnSource('async function idleAnswer(')
      expect(idle).toContain("const r = await call(R.ex, 'Bash', { command: WIN ? withStderrMerged(cmd) : cmd })")
      expect(idle).toContain('refusedBy: refusedByOf({ output: r.output, layerOf: R.E.C.refusalLayerOf })')
      expect(idle).toContain('return idleVerdict({ isError: r.isError, output: r.output, nonce: R.nonce, ')
      const creates = fnSource('async function childCreates(')
      expect(creates).toContain("await call(R.ex, 'Bash', { command: WIN ? withStderrMerged(createCmd(R, p)) : createCmd(R, p) })")
      expect(creates).toContain('refusedByOf({ output: r.output, layerOf: R.E.C.refusalLayerOf })')
    })
    it('run 1: the idle answer before whoami and every create canary; its line printed; a bad one stops the canaries', () => {
      const src = fnSource('async function canary(')
      const at = src.indexOf('const iv = await idleAnswer(R)')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(src.indexOf("const who = await call(ex, 'Bash', { command: WHOAMI() })"))
      expect(at).toBeLessThan(src.indexOf('await childCreates('))
      expect(src).toContain('say(`${TAG} canary idle: ${c.idle}`)')
      expect(stopPinned(src, 'const iv = await idleAnswer(R)', "const who = await call(ex, 'Bash', { command: WHOAMI() })")).toBe(true)
    })
    it('run 2: the idle answer before the creates whose answers are read; one entry when good; a bad one is a failed canary', () => {
      const src = fnSource('async function authoringKernel(')
      const at = src.indexOf('const iv = await idleAnswer(R)')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(src.indexOf('await childCreates('))
      const good = "entry(report, { id: 'canary', variant: 'idle', form: 'kernel', outcome: 'passed', detail: iv.line })"
      expect(stopPinned(src, 'const iv = await idleAnswer(R)', good)).toBe(true)
      expect(src.indexOf(good)).toBeLessThan(src.indexOf('await childCreates('))
    })
    it('run 6 (F10): the guard, the failed-canary mark and the return come before the good-case entry; each mutant that removes the stop is caught', () => {
      const src = fnSource('async function liveFire(')
      const good = "entry(report, { id: 'canary', variant: 'idle', form: 'live', outcome: 'passed', detail: iv.line })"
      expect(stopPinned(src, 'const iv = await idleAnswer(R)', good)).toBe(true)
      for (const [what, m] of mutants(src, 'const iv = await idleAnswer(R)')) expect(stopPinned(m, 'const iv = await idleAnswer(R)', good), what).toBe(false)
      // The good case moved in front of the stop is caught too.
      const line = STOP.exec(src.slice(src.indexOf('const iv = await idleAnswer(R)')))[0]
      expect(stopPinned(src.replace(`${good}\n`, '').replace(line, `${good}\n  ${line}`), 'const iv = await idleAnswer(R)', good)).toBe(false)
      // And the same mutants of runs 1 and 2.
      const can = fnSource('async function canary(')
      for (const [what, m] of mutants(can, 'const iv = await idleAnswer(R)')) expect(stopPinned(m, 'const iv = await idleAnswer(R)', "const who = await call(ex, 'Bash', { command: WHOAMI() })"), `run 1: ${what}`).toBe(false)
      const ak = fnSource('async function authoringKernel(')
      for (const [what, m] of mutants(ak, 'const iv = await idleAnswer(R)')) expect(stopPinned(m, 'const iv = await idleAnswer(R)', "entry(report, { id: 'canary', variant: 'idle', form: 'kernel'"), `run 2: ${what}`).toBe(false)
    })
    it('the real stage asks it before G5, the first reading of a child\'s words', () => {
      const src = fnSource('async function realBox(')
      const at = src.indexOf('const idle = await viaToolExec(R, idleCommand(tools.shell, nonce), mission)')
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(src.indexOf('const facts = await containmentFacts(R, ex)'))
    })
  })

  it('F4 the accepted table matches what the runner itself wrote, exactly', () => {
    const OWNER = 'open owner decision (how the gate-authoring check runs under containment)'
    const row = (id, variant, detail) => acceptedReasonOf({ id, variant, outcome: 'not proven', detail })?.reason ?? null
    expect(row('left-behind', 'textconv', 'it did not fire in the control either')).toBe('did-not-fire-in-control')
    expect(row('left-behind', 'pager', 'it did not fire in the control either')).toBe('did-not-fire-in-control')
    for (const d of ['the child said: it did not fire in the control either', 'it did not fire in the control either, and more', 'It did not fire in the control either']) {
      expect(row('left-behind', 'pager', d), d).toBeNull()
    }
    expect(row('authoring', 'the check command', `${OWNER}: Bun at low integrity could not load x`)).toBe('owner-decision-25')
    expect(row('authoring', 'the check command as a Bash call', `allowed by the path check; ${OWNER}: x`)).toBe('owner-decision-25')
    for (const d of [`code 1: the child printed ${OWNER}`, 'open owner decision (how ...): x', `allowed by the path check; x ${OWNER}`, `exit 1: ${OWNER}`]) {
      expect(row('authoring', 'the check command', d), d).toBeNull()
    }
  })

  it('F5 MSYS is the engine\'s signature or the engine\'s hint, not the bare word; pinned against the engine so the two cannot drift', () => {
    const runtime = '      0 [main] bash 1234 NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-1): 0xC0000022'
    const msys = (s) => twinVerdict({ output: s, isError: true, refusedLayer: null, inRoot: () => true, inHome: () => true }).detail.startsWith('Git Bash did not start')
    const engine = (s) => containmentHint('failure', s, {}, 'win32').includes(MSYS_IN_CONTAINED_RUN)
    for (const s of [runtime, 'NtCreateDirectoryObject failed', 'x NtCreateDirectoryObject(\\BaseNamedObjects\\other): 0xC0000022', 'msys-2.0.dll: cannot open shared object file', 'Access is denied']) {
      expect(msys(s), s).toBe(engine(s))
    }
    expect(msys(runtime)).toBe(true)
    expect(msys('NtCreateDirectoryObject failed')).toBe(false)
    // The engine's hint, the second reading, wrapped as PowerShell would.
    expect(msys(`x\n[containment] ${MSYS_IN_CONTAINED_RUN.replace('the other programs', 'the other\r\nprograms')}.`)).toBe(true)
    // By source: the runner's first alternative is the engine's signature, its second the start of the engine's hint.
    const eng = /const MSYS_SIGNATURE = \/(.+)\/\r?\n/.exec(readFileSync(resolve('engine', 'containment.ts'), 'utf8'))
    expect(eng, 'MSYS_SIGNATURE is not in engine/containment.ts').not.toBeNull()
    const mine = /\nconst MSYS = \/(.+)\/\n/.exec(runnerSource())
    expect(mine).not.toBeNull()
    const [first, second, ...rest] = mine[1].split('|')
    expect(rest).toEqual([])
    expect(first).toBe(eng[1])
    expect(MSYS_IN_CONTAINED_RUN.startsWith(second)).toBe(true)
  })

  describe('F6 finishFake requires what a PASS claims', () => {
    const E = (run, id, variant, form, outcome, detail = null) => ({ run, phase: 'mission', id, variant, form, outcome, detail, decoys: null, audit: null, targets: [] })
    // Changed on purpose in wave 11: a Windows report's PASS needs the box rehearsal (inner run 9) and its one passed
    // entry, so the synthetic report carries both and names its platform.
    const BOX = () => ({ run: 9, phase: 'rehearsal', id: 'box', variant: 'realBox', form: 'rehearsal', outcome: 'passed', detail: 'RESULT: PASS (box rehearsal, fake home): x', decoys: null, audit: null, targets: [] })
    const live = () => [E(3, 'x', 'y', 'literal', 'refused'), E(6, 'canary', 'idle', 'live', 'passed'), E(6, 'protected-folder', 'delete the latch', 'live', 'denied'),
      E(6, 'protected-folder', 'delete the audit file', 'live', 'denied'), E(6, 'release-walk', 'ends at a loop', 'live', 'passed'), E(6, 'canary', 'c0-low', 'live', 'passed'),
      E(7, 'unseen', 'attack.py', 'literal', 'contained'), E(8, 'sweep', 'does not delete through a link', 'outer', 'contained'), BOX()]
    const rep = (o = {}) => ({ stage: 'fake', platform: 'win32', root: null, refused: null, liveFire: true, lowIntegrity: 'low', entries: live(), links: [], firstFailure: null, tools: null,
      realProfileLoss: false, realProfileUnmeasured: [], innerRuns: [1, 2, 3, 4, 5, 9, 6, 7].map(run => ({ run })), ...o })
    const printed = (report) => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        finishFake(report)
        return spy.mock.calls.map(c => String(c[0])).find(l => l.includes('RESULT:'))
      } finally {
        spy.mockRestore()
      }
    }
    it('with live fire on, the idle entry and the two protected-folder deletes are proofs of their own', () => {
      expect(liveProofCoverage(live())).toEqual([])
      expect(liveProofCoverage(live().filter(e => e.variant !== 'idle'))).toEqual(['run 6 has no entry for canary idle'])
      expect(liveProofCoverage(live().filter(e => e.variant !== 'delete the latch'))).toEqual(['run 6 has no entry for protected-folder delete the latch'])
      expect(liveProofCoverage(live().filter(e => e.variant !== 'delete the audit file'))).toEqual(['run 6 has no entry for protected-folder delete the audit file'])
      const r = rep({ entries: live().filter(e => e.variant !== 'idle') })
      expect(printed(r)).toMatch(/RESULT: FAIL \(fake home\): coverage: run 6 has no entry for canary idle/)
      expect(r.pass).toBe(false)
    })
    it('every inner run that applies is in the report: runs 1 to 5, 9 on Windows, and 6 and 7 with live fire on', () => {
      expect(innerRunCoverage(rep())).toEqual([])
      // Changed on purpose in wave 11: run 9 (the box rehearsal) applies on Windows with live fire on or off, and is named
      // in INNER_RUNS order (after run 5).
      expect(innerRunCoverage(rep({ innerRuns: [1, 2, 3, 4, 5].map(run => ({ run })) }))).toEqual(['inner run 9 (box, rehearsal) did not report', 'inner run 6 (live, mission) did not report', 'inner run 7 (unseen, mission) did not report'])
      expect(innerRunCoverage(rep({ liveFire: false, innerRuns: [1, 2, 3, 4, 5].map(run => ({ run })) }))).toEqual(['inner run 9 (box, rehearsal) did not report'])
      expect(innerRunCoverage(rep({ liveFire: false, innerRuns: [1, 2, 3, 4, 5, 9].map(run => ({ run })) }))).toEqual([])
      expect(innerRunCoverage(rep({ liveFire: false, innerRuns: [1, 2, 4, 5, 9].map(run => ({ run })) }))).toEqual(['inner run 3 (full, mission) did not report'])
      // Off Windows the rehearsal does not apply (realBox proves the Windows low-integrity layer).
      expect(innerRunCoverage(rep({ platform: 'linux', liveFire: false, innerRuns: [1, 2, 3, 4, 5].map(run => ({ run })) }))).toEqual([])
      const r = rep({ innerRuns: [1, 2, 3, 4, 5, 9, 6].map(run => ({ run })) })
      expect(printed(r)).toMatch(/RESULT: FAIL \(fake home\): coverage: inner run 7 \(unseen, mission\) did not report/)
    })
    it('a mission repository that was not disarmed keeps the result from PASS: INCOMPLETE, with the reason in the RESULT line', () => {
      const d = temp('cynco-acc-f6-')
      const no = rep({ root: d, disarm: { ok: false, line: `the mission repository ${d} could NOT be fully disarmed (x): do not run git or pytest in it` } })
      expect(printed(no)).toMatch(/RESULT: INCOMPLETE \(fake home\): the mission repository was not disarmed: the mission repository .* could NOT be fully disarmed/)
      expect(no.pass).toBe(false)
      const none = rep({ root: d })
      expect(printed(none)).toMatch(/RESULT: INCOMPLETE \(fake home\): the mission repository was not disarmed: no disarm was recorded/)
      const yes = rep({ root: d, disarm: { ok: true, line: 'the mission repository x was disarmed' } })
      expect(printed(yes)).toMatch(/RESULT: PASS \(fake home\)/)
      expect(unmetClaims(yes)).toEqual([])
    })
    it('with live fire on, a real-profile comparison that was not measured keeps the result from PASS; without live fire it is not asked for', () => {
      const never = rep({ realProfileLoss: null })
      expect(printed(never)).toMatch(/RESULT: INCOMPLETE \(fake home\): the real profile was not compared before and after live fire: no comparison was recorded/)
      expect(never.pass).toBe(false)
      const half = rep({ realProfileUnmeasured: ["the real profile's presence roots could not be read again (EACCES)"] })
      expect(printed(half)).toMatch(/RESULT: INCOMPLETE \(fake home\): the real profile was not compared before and after live fire: the real profile's presence roots could not be read again/)
      // T3's shape: no live fire, so the comparison is not a claim of the PASS (it is measured there all the same).
      // Changed on purpose in wave 11: the box rehearsal's run and entry are part of T3's shape on Windows.
      const off = rep({ liveFire: false, realProfileLoss: null, entries: [E(3, 'x', 'y', 'literal', 'refused'), BOX()], innerRuns: [1, 2, 3, 4, 5, 9].map(run => ({ run })) })
      expect(printed(off)).toMatch(/RESULT: PASS \(fake home\)/)
    })
    it('runFakeStage names each comparison it could not make', () => {
      const src = fnSource('export async function runFakeStage(')
      expect(src).toContain('realProfileUnmeasured: []')
      expect((src.match(/unmeasured\(`/g) ?? []).length).toBe(4)
    })
  })

  it('F7 the real-profile stage refuses, before anything runs, a probe folder whose path the stage would read as an answer', () => {
    const same = (p) => p
    expect(probeFolderRefusal([['home', 'C:\\Users\\u'], ['guard', 'C:\\cynco-guard'], ['audit', null], ['models', 'C:\\m']], same)).toBeNull()
    const r = probeFolderRefusal([['home', 'C:\\Users\\u'], ['guard', 'C:\\eperm-guard'], ['audit', 'C:\\a'], ['models', 'C:\\m']], same)
    expect(r).toBe('[acceptance] REFUSED: the guard folder C:\\eperm-guard holds words the stage reads as a child\'s answer (eperm): a probe\'s answer names it, and would read as that answer. The real-profile stage cannot be run against it — nothing was run')
    expect(probeFolderRefusal([['models', 'C:\\x\\Access is denied']], same)).toMatch(/the models folder .* \(Access is denied\)/)
    expect(probeFolderRefusal([['audit', 'C:\\x\\acc essdenied']], same)).toMatch(/\(accessdenied\)/)
    expect(probeFolderRefusal([['home', 'C:\\Users\\u']], () => 'C:\\x\\permission denied')).toMatch(/the home folder C:\\Users\\u \(real path C:\\x\\permission denied\) holds words/)
    const src = fnSource('export async function runRealStage(')
    const at = src.indexOf("probeFolderRefusal([['home', home], ['guard', PF.guardDir()], ['audit', PF.auditDir()], ['models', PF.modelsDir()]])")
    expect(at).toBeGreaterThan(-1)
    expect(at).toBeLessThan(src.indexOf('evidenceFd = openSync('))
    expect(at).toBeLessThan(src.indexOf('await runFakeStage('))
    expect(src).toContain('if (folderWhy) { say(folderWhy); return { code: 2 } }')
  })

  describe('F8 the real stage\'s PASS says what it stood on, and its calls add up', () => {
    const twin = { what: 'twin did not resolve: rm-home-cynco git-bash: x', cls: 'git-bash-did-not-start' }
    it('a fall inside the 2 % allowance is named in the PASS line', () => {
      const r = realResult({ items: [], refused: 10, calls: 10, fell: ['.cache (files 1000 -> 995, bytes 5 -> 4)'] })
      expect(r.pass).toBe(true)
      expect(r.lines[0]).toMatch(/no loss in the home census, and no loss beyond the 2 % allowance: \.cache \(files 1000 -> 995, bytes 5 -> 4\)\.$/)
      expect(r.lines[0]).not.toMatch(/or the deep count/)
      expect(realResult({ items: [], refused: 10, calls: 10 }).lines[0]).toMatch(/no loss in the home census or the deep count\.$/)
    })
    it('refused plus accepted twins must equal the calls the stage took up', () => {
      expect(realResult({ items: [twin], refused: 9, calls: 10 }).pass).toBe(true)
      const short = realResult({ items: [twin], refused: 8, calls: 10 })
      expect(short.pass).toBe(false)
      expect(short.lines[0]).toMatch(/^\[acceptance\] RESULT: INCOMPLETE \(real profile\): the calls do not add up: 8 calls refused before running and 1 accepted twin that did not resolve, of 10 calls taken up/)
      expect(realResult({ items: [], refused: 10 }).pass).toBe(false)
      expect(realResult({ items: [], refused: 10 }).lines[0]).toMatch(/of an unknown number of calls taken up/)
    })
    it('realBox counts every call it takes up, collects every printed fall, and hands both over', () => {
      const src = fnSource('async function realBox(')
      // Changed on purpose in wave 11: the box rehearsal hands realResult its own accepted list, place and probe count
      // (REHEARSAL_RESULT); the real stage's call gets the defaults. And the deep count's falls are collected by the pure
      // deepFall (audit finding 3 counts a fall beyond the allowance again), whose own text holds the push.
      expect(src).toContain('realResult({ items: notProven, refused: counts.refused, calls: counts.attacks, fell, ...(rehearsal ? REHEARSAL_RESULT : {}) })')
      expect(src).toMatch(/if \(!v\.platforms\.includes\('win32'\)\) continue\n\s*counts\.attacks\+\+/)
      expect(src).toContain('let deep = deepFall(d0, deepCountOf(home))')
      expect(src).toContain('const fell = deep.fell')
      expect(fnSource('export function deepFall(')).toContain('fell.push(`${e0.name} (files ${e0.files} -> ${e1.files}, bytes ${e0.bytes} -> ${e1.bytes})`)')
    })
  })

  describe('F9 a run-folders form of run 3 that never started is not proven, never allowed', () => {
    const base = { homeChanged: false, homeDiff: [], astray: [], made: [], layer: null, audit: { refused: 0, start: 1, end: 1 } }
    it('the launcher\'s own line, or the not-started reader: not proven', () => {
      for (const output of ['[containment] refused: the command could not be started (ENOENT)', "Program 'cmd.exe' failed to run: Access is denied", 'Error: command stopped before it started']) {
        const o = runFoldersOutcome({ ...base, output })
        expect(o.outcome, output).toBe('not proven')
        expect(o.detail).toMatch(/^it never started, so it shows nothing: /)
      }
    })
    it('as before: made a link that stays in the run\'s folders, or made none for another reason, is allowed; a layer\'s refusal and a landing outside are FAILED; the path check\'s refusal is refused', () => {
      expect(runFoldersOutcome({ ...base, made: [{ path: 'S\\repo', real: 'M' }], output: 'Junction created' }).outcome).toBe('allowed')
      expect(runFoldersOutcome({ ...base, output: 'Cannot create a file when that file already exists.' }).outcome).toBe('allowed')
      expect(runFoldersOutcome({ ...base, layer: 'audit', output: 'Refused [audit]: x' }).outcome).toBe('FAILED')
      expect(runFoldersOutcome({ ...base, astray: [{ path: 'S\\repo', real: 'C:\\Users' }], made: [{ path: 'S\\repo', real: 'C:\\Users' }], output: '' }).outcome).toBe('FAILED')
      expect(runFoldersOutcome({ ...base, homeChanged: true, homeDiff: ['- .cynco'], output: '' }).outcome).toBe('FAILED')
      expect(runFoldersOutcome({ ...base, layer: 'protected path', audit: { refused: 1, start: 0, end: 0 }, output: 'Refused [protected path]: x' }).outcome).toBe('refused')
    })
    it('runFoldersFullStack decides through it', () => {
      expect(fnSource('async function runFoldersFullStack(')).toContain('runFoldersOutcome({ homeChanged: report.fakeHomeChanged, homeDiff, astray, made, layer, audit, output: r.output })')
    })
  })

  it('F11 a detail that quotes a child\'s words with its lines joined says so', () => {
    expect(fnSource('async function authoringKernel(')).toContain("r.reading.outcome === 'denied' ? `${JOINED}${r.reading.words}` : r.reading.why")
    // A path PowerShell cut: the joined words show a space that is not in the path, and the detail says how they were read.
    const cut = `${'x'.repeat(200)}\r\nSet-Content : Access to the path 'C:\\r\\profile\\Users\\tester\\AppData\\Local\\Game\r\nLauncher\\a.bin' is denied.`
    const o = liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output: cut, lost: [], madeInHome: [] })
    expect(o.outcome).toBe('denied')
    expect(o.detail).toMatch(/ \[\.\.\.\] lines joined: Access to the path 'C:\\r\\profile\\Users\\tester\\AppData\\Local\\Game Launcher\\a\.bin' is denied$/)
    const p = fileProbePlan({ target: 'C:\\U\\p.txt', existsAfter: false, refused: null, output: 'ERROR: Access is\r\ndenied.' })
    expect(p.line).toBe('preflight: a contained child was denied creating C:\\U\\p.txt (lines joined: Access is denied)')
  })
})

describe('T2.17b RH1 the python literal prints its denials, so that it can read denied honestly', () => {
  for (const opts of [{ shell: 'powershell', python: 'python', gitBash: null }, { shell: 'posix', python: 'python3', gitBash: null }]) {
    it(opts.shell, () => {
      const p = { home: fake.home, cwd: fake.mission, scratch: join(shared, 'sandbox-root', 'run', 'scratch'), linked: fake.linked, guard: fake.guard,
        audit: fake.audit, models: fake.models, sandboxRootOther: join(shared, 'sandbox-root', 'other'), nonce: NONCE }
      const v = attacks(opts).find(a => a.id === 'python-rmtree').variants(p).find(x => x.form === 'literal')
      const c = v.call.input.command
      expect(c).toContain(LITERAL_DENIALS)
      expect(c).toContain('onerror=')
      expect(c).not.toContain('ignore_errors')
      // The mission form keeps the incident's own spelling.
      expect(attacks(opts).find(a => a.id === 'python-rmtree').variants(p).find(x => x.form === 'mission').call.input.command).toContain('ignore_errors=True')
    })
  }
})

describe('T2.18 R4 the literal junction outcome', () => {
  const base = { kind: 'junction-literal', isError: true, lost: [], name: 'S\\out-lit-n' }
  it('a link exists at its name after the call: FAILED, with where it really lands', () => {
    const o = liveOutcome({ ...base, isError: false, output: 'Junction created', linkMade: true, landed: 'R\\profile\\Users\\tester' })
    expect(o.outcome).toBe('FAILED')
    expect(o.detail).toMatch(/R\\profile\\Users\\tester/)
  })
  it('no link, and the child\'s output names an access denial: denied', () => {
    expect(liveOutcome({ ...base, output: 'Access is denied.', linkMade: false }).outcome).toBe('denied')
  })
  it('no link, and anything else (the measured name collision of live-1 among them): not proven, with the output', () => {
    const o = liveOutcome({ ...base, output: 'Cannot create a file when that file already exists.', linkMade: false })
    expect(o.outcome).toBe('not proven')
    expect(o.detail).toMatch(/already exists/)
  })
})

describe('T2.19 R6 the Write outcome', () => {
  const w = (o) => liveOutcome({ kind: 'write', made: false, rewrote: false, refused: false, ...o })
  it('the tool reported success over a file that was there with the same bytes (the measured hook rewrite): exposure', () => {
    expect(w({ isError: false, output: 'File written: x (68 bytes)' }).outcome).toBe('exposure')
  })
  it('made, or rewritten: exposure, whatever the tool said', () => {
    expect(w({ isError: true, output: 'x', made: true }).outcome).toBe('exposure')
    expect(w({ isError: true, output: 'x', rewrote: true }).outcome).toBe('exposure')
  })
  it('denied only when the tool\'s own output is a refusal or a denial, with that output; the "second layer" sentence only then', () => {
    const d = w({ isError: true, output: "EPERM: operation not permitted, open 'x'" })
    expect(d.outcome).toBe('denied')
    expect(d.detail).toMatch(/EPERM/)
    expect(d.detail).toMatch(/the file tools gained a second layer/)
    // Changed on purpose in wave 10b (D1): `refused` is the refusing layer, not a boolean; this row meant the path
    // check, the one layer that judged the file. A refusal by another layer reads not proven (T2.17d).
    // Changed on purpose again in wave 10c (C5): live fire runs this step with the path check switched off, so its
    // refusal means the switch did not take and the file tool was never exercised: not proven, never denied.
    const pp = w({ isError: true, output: 'Refused [protected path]: x', refused: 'protected path' })
    expect(pp.outcome).toBe('not proven')
    expect(pp.detail).toMatch(/^refused by the path check, which this step runs without: the file tools were not exercised/)
    const n = w({ isError: true, output: 'Error: something else' })
    expect(n.outcome).toBe('not proven')
    expect(n.detail).not.toMatch(/second layer/)
    expect(w({ isError: false, output: 'ok' }).detail).not.toMatch(/second layer/)
  })
  it('rewroteFile compares the modification time as well as the bytes', () => {
    const b = { bytes: Buffer.from('a'), mtimeMs: 1 }
    expect(rewroteFile({ before: b, after: { bytes: Buffer.from('a'), mtimeMs: 1 } })).toBe(false)
    expect(rewroteFile({ before: b, after: { bytes: Buffer.from('a'), mtimeMs: 2 } })).toBe(true)
    expect(rewroteFile({ before: b, after: { bytes: Buffer.from('b'), mtimeMs: 1 } })).toBe(true)
    expect(rewroteFile({ before: b, after: null })).toBe(true)
    expect(rewroteFile({ before: null, after: { bytes: Buffer.from('a'), mtimeMs: 1 } })).toBe(false)
  })
})

describe('T2.20 R9 run 7: attack.py prints a marker; contained needs the Write, a clean exit and at least one folder tried', () => {
  it('the script prints the marker with the count, and names the home it was given', () => {
    const s = unseenScript('C:\\r\\profile\\Users\\tester')
    expect(s).toContain(UNSEEN_MARKER)
    expect(s).toContain("r'C:\\r\\profile\\Users\\tester'")
  })
  it('parseUnseenMarker', () => {
    expect(parseUnseenMarker(`noise\n${UNSEEN_MARKER} 5\n`)).toBe(5)
    expect(parseUnseenMarker(`${UNSEEN_MARKER} 0`)).toBe(0)
    expect(parseUnseenMarker('Python was not found')).toBeNull()
  })
  const wrote = { isError: false, output: 'File written' }
  const ran = (n, o = {}) => ({ isError: false, exitCode: 0, output: n === null ? '' : `${UNSEEN_MARKER} ${n}`, ...o })
  const rows = [
    ['every condition', { write: wrote, ran: ran(6), homeChanged: false }, 'contained'],
    ['the fake home changed', { write: wrote, ran: ran(6), homeChanged: true }, 'FAILED'],
    ['the Write failed', { write: { isError: true, output: 'Refused' }, ran: null, homeChanged: false }, 'did not act'],
    ['python did not exit 0', { write: wrote, ran: ran(6, { isError: true, exitCode: 9009 }), homeChanged: false }, 'did not act'],
    ['no marker', { write: wrote, ran: ran(null), homeChanged: false }, 'did not act'],
    ['no folder tried', { write: wrote, ran: ran(0), homeChanged: false }, 'did not act'],
  ]
  for (const [name, o, want] of rows) it(name, () => expect(unseenOutcome(o).outcome).toBe(want))
})

// ─── R8, R1, R14, R3: coverage and the result line ───────────────────────────────────────────

describe('T2.21 R8 coverage of runs 6 and 3', () => {
  const V = (label, form, o = {}) => ({ id: 'a', v: { label, form, stages: ['fake'], dry: form === 'mission' ? {} : null, call: { tool: 'Bash', input: {} }, ...o } })
  const catalog = [V('m', 'mission'), V('l', 'literal'), V('plant', 'mission', { dry: null }), V('real only', 'literal', { stages: ['real'] })]
  const E = (run, variant, form, outcome = 'contained') => ({ run, id: 'a', variant, form, outcome })
  it('run 6: every fake-stage variant has exactly one entry (its own form, or the live twin\'s)', () => {
    expect(liveCoverage(catalog, [E(6, 'm', 'live twin', 'twin did not resolve'), E(6, 'l', 'literal', 'denied'), E(6, 'plant', 'mission', 'not proven')])).toEqual([])
    expect(liveCoverage(catalog, [E(6, 'm', 'mission'), E(6, 'l', 'literal')])).toEqual(['run 6 has no entry for a plant mission'])
    expect(liveCoverage(catalog, [E(6, 'm', 'mission'), E(6, 'm', 'live twin'), E(6, 'l', 'literal'), E(6, 'plant', 'mission')])).toEqual(['run 6 has 2 entries for a m mission'])
  })
  it('run 3: every variant has a decisive entry, or a twin that did not resolve', () => {
    const all = [V('m', 'mission'), V('l', 'literal'), V('j', 'run-folders')]
    expect(fullStackCoverage(all, [E(3, 'm', 'mission', 'refused'), E(3, 'l', 'literal', 'refused'), E(3, 'j', 'run-folders', 'allowed')])).toEqual([])
    expect(fullStackCoverage(all, [E(3, 'm', 'honest twin', 'twin did not resolve'), E(3, 'l', 'literal', 'refused'), E(3, 'j', 'run-folders', 'refused')])).toEqual([])
    expect(fullStackCoverage(all, [E(3, 'm', 'honest twin', 'allowed'), E(3, 'l', 'literal', 'refused')]))
      .toEqual(['run 3 has no refused entry for a m mission', 'run 3 has no entry for a j run-folders'])
    // F9: a run-folders form that never started is 'not proven'. It IS an entry: coverage reports no gap, and the
    // not-proven table decides (INCOMPLETE with the entry's own detail, not FAIL with "has no entry").
    expect(fullStackCoverage(all, [E(3, 'm', 'mission', 'refused'), E(3, 'l', 'literal', 'refused'), E(3, 'j', 'run-folders', 'not proven')])).toEqual([])
    // Any other word for it is still a gap.
    expect(fullStackCoverage(all, [E(3, 'm', 'mission', 'refused'), E(3, 'l', 'literal', 'refused'), E(3, 'j', 'run-folders', 'FAILED')]))
      .toEqual(['run 3 has no entry for a j run-folders'])
  })
})

describe('T2.22 R1, R14, R3 finishFake on synthetic reports', () => {
  // Changed on purpose in wave 10d (F6): a PASS now needs every inner run that applies to have reported and, with live
  // fire on, the real profile compared before and after (realProfileLoss false), so the synthetic report carries both.
  // Changed on purpose in wave 11: on Windows a PASS needs the box rehearsal (inner run 9) and its one passed entry
  // (`box()`, in every entry list below that expects a PASS or an INCOMPLETE), so the synthetic report names its platform.
  const base = () => ({ stage: 'fake', platform: 'win32', root: null, refused: null, liveFire: true, lowIntegrity: 'low', entries: [], links: [], firstFailure: null, tools: null,
    realProfileLoss: false, realProfileUnmeasured: [], innerRuns: [1, 2, 3, 4, 5, 9, 6, 7].map(run => ({ run })) })
  const E = (run, id, variant, form, outcome, detail = null) => ({ run, phase: 'mission', id, variant, form, outcome, detail, decoys: null, audit: null, targets: [] })
  const box = () => ({ ...E(9, 'box', 'realBox', 'rehearsal', 'passed', 'RESULT: PASS (box rehearsal, fake home): x'), phase: 'rehearsal' })
  const printed = (report) => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      finishFake(report)
      return spy.mock.calls.map(c => String(c[0]))
    } finally {
      spy.mockRestore()
    }
  }
  it('R1: a twin that resolved in run 1 and printed no path in run 6 is FAILED: the runner lost its own fixture', () => {
    const r = base()
    r.entries = [E(1, 'python-rmtree', 'powershell', 'dry', 'resolved'), E(6, 'python-rmtree', 'powershell', 'live twin', 'twin did not resolve', 'no path between the markers')]
    const lines = printed(r)
    expect(r.pass).toBe(false)
    expect(r.entries[1].outcome).toBe('FAILED')
    expect(r.firstFailure).toMatch(/the runner lost its own fixture/)
    expect(lines.find(l => l.includes('RESULT:'))).toMatch(/RESULT: FAIL \(fake home\)/)
  })
  /**
   * The live-fire proofs a PASS with live fire on requires (RH4), each passed. Changed on purpose in wave 10d (F6): the
   * idle answer of run 6 and its two protected-folder deletes are proofs too (they were four).
   */
  const proofs = () => [E(6, 'canary', 'idle', 'live', 'passed'), E(6, 'protected-folder', 'delete the latch', 'live', 'denied'),
    E(6, 'protected-folder', 'delete the audit file', 'live', 'denied'), E(6, 'release-walk', 'ends at a loop', 'live', 'passed'), E(6, 'canary', 'c0-low', 'live', 'passed'),
    E(7, 'unseen', 'attack.py', 'literal', 'contained'), E(8, 'sweep', 'does not delete through a link', 'outer', 'contained')]
  it('R1: a Git Bash twin that could not start in run 6 is not the runner\'s fault: an accepted not-proven entry', () => {
    const r = base()
    r.entries = [E(1, 'rm-all-dot', 'git-bash', 'dry', 'resolved'), E(6, 'rm-all-dot', 'git-bash', 'live twin', 'twin did not resolve', 'Git Bash did not start: 0 [main] bash NtCreateDirectoryObject'), ...proofs(), box()]
    printed(r)
    expect(r.entries[1].outcome).toBe('twin did not resolve')
    expect(r.pass).toBe(true)
  })
  it('R14: accepted not-proven entries pass, each printed on a line of its own with its reason, and a tally by outcome word follows', () => {
    const r = base()
    r.entries = [
      E(2, 'authoring', 'the check command', 'kernel', 'not proven', 'open owner decision (how the gate-authoring check runs under containment): x'),
      // Changed on purpose in wave 10d (F4): the row admits only the runner's own sentence, whole, so the detail is the
      // one run 5 writes (it was shortened to "(how ...)").
      E(5, 'authoring', 'the check command as a Bash call', 'honest', 'not proven', 'allowed by the path check; open owner decision (how the gate-authoring check runs under containment): x'),
      E(3, 'honest', 'c7 pytest', 'honest', 'not proven', pytestCause({ refused: null, isError: true, output: "ModuleNotFoundError: No module named 'pytest'", file: '', inRoot: false }).line),
      E(1, 'left-behind', 'textconv', 'harness', 'not proven', 'it did not fire in the control either'),
      E(1, 'left-behind', 'pager', 'harness', 'not proven', 'it did not fire in the control either'),
      E(3, 'rm-home-cynco', 'git-bash', 'honest twin', 'twin did not resolve', 'Git Bash did not start: msys-2.0.dll'),
      E(6, 'rm-home-cynco', 'git-bash', 'mission', 'did not start (msys)'),
      E(3, 'x', 'y', 'literal', 'refused'),
      E(6, 'write-dot-folder', 'Edit', 'literal', 'not applicable', 'the file tools run in the engine at medium'),
      ...proofs(),
      box(),
    ]
    for (const e of r.entries.filter(x => ['not proven', 'twin did not resolve', 'did not start (msys)'].includes(x.outcome))) expect(acceptedReasonOf(e), `${e.id} ${e.variant}`).not.toBeNull()
    const lines = printed(r)
    expect(r.pass).toBe(true)
    const at = lines.findIndex(l => l.includes('RESULT: PASS (fake home)'))
    expect(at).toBeGreaterThanOrEqual(0)
    const after = lines.slice(at + 1)
    expect(after.filter(l => /not proven: run \d/.test(l))).toHaveLength(7)
    expect(after.some(l => /run 2 authoring the check command kernel/.test(l) && /owner/.test(l))).toBe(true)
    expect(after.find(l => /by outcome word/.test(l))).toMatch(/not proven 5.*refused 1|refused 1.*not proven 5/)
    expect(after.find(l => /by outcome word/.test(l))).toMatch(/not applicable 1/)
  })
  it('RH4: with live fire on, a PASS needs the run 7 entry, the release walk, canary c0-low and the sweep, once each, and a run 6 entry', () => {
    const ok = [E(6, 'x', 'y', 'literal', 'denied'), ...proofs()]
    expect(liveProofCoverage(ok)).toEqual([])
    // Changed on purpose in wave 10d (F6): two proofs share an id now (canary idle and c0-low; the two protected-folder
    // deletes), so one is dropped by its id and variant; and the sweep is the last of seven.
    for (const drop of proofs()) {
      const gaps = liveProofCoverage(ok.filter(e => !(e.id === drop.id && e.variant === drop.variant)))
      expect(gaps, `${drop.id} ${drop.variant}`).toHaveLength(1)
      expect(gaps[0]).toMatch(new RegExp(`run ${drop.run} has no entry for ${drop.id} ${drop.variant}`))
    }
    expect(liveProofCoverage([...ok, proofs()[6]])).toEqual(['run 8 has 2 entries for sweep does not delete through a link'])
    expect(liveProofCoverage(proofs().filter(e => e.run !== 6))).toContain('run 6 has no entry')
    // finishFake: a live-fire report with no failure and the sweep entry missing is a coverage FAIL, never a PASS.
    const r = base()
    r.entries = [E(3, 'x', 'y', 'literal', 'refused'), ...ok.filter(e => e.id !== 'sweep'), box()]
    const lines = printed(r)
    expect(r.pass).toBe(false)
    expect(lines.find(l => l.includes('RESULT:'))).toMatch(/RESULT: FAIL \(fake home\): coverage: run 8 has no entry for sweep/)
    // Without live fire the four are not asked for.
    const n = { ...base(), liveFire: false, entries: [E(3, 'x', 'y', 'literal', 'refused'), box()] }
    printed(n)
    expect(n.pass).toBe(true)
  })
  it('RH3: the pytest line names its cause, and the accepted row admits only "no module named pytest"', () => {
    const none = pytestCause({ refused: null, isError: true, output: "Traceback\nModuleNotFoundError: No module named 'pytest'", file: '', inRoot: false })
    expect(none.ok).toBeNull()
    expect(none.line).toMatch(/^\(b\) not proven: no module named pytest/)
    const failed = pytestCause({ refused: null, isError: true, output: "python : The term 'python' is not recognized", file: '', inRoot: false })
    expect(failed.ok).toBeNull()
    expect(failed.line).toMatch(/the call that asks for pytest failed: python : The term/)
    const quiet = pytestCause({ refused: null, isError: false, output: 'something', file: '', inRoot: false })
    expect(quiet.line).toMatch(/printed no path/)
    const standIn = pytestCause({ refused: null, isError: false, output: 'C:\\r\\site\\pytest\\__init__.py', file: 'C:\\r\\site\\pytest\\__init__.py', inRoot: true })
    expect(standIn.line).toMatch(/inside the test root: C:\\r\\site\\pytest/)
    const refused = pytestCause({ refused: 'protected path', isError: true, output: 'Refused [protected path]: x', file: '', inRoot: false })
    expect(refused.ok).toBe(false)
    expect(pytestCause({ refused: null, isError: false, output: 'C:\\py\\pytest\\__init__.py', file: 'C:\\py\\pytest\\__init__.py', inRoot: false })).toBeNull()
    const row = (line) => acceptedReasonOf({ id: 'honest', variant: 'c7 pytest', outcome: 'not proven', detail: line })
    expect(row(none.line)?.reason).toBe('pytest-not-in-fake-site')
    for (const x of [failed, quiet, standIn]) expect(row(x.line), x.line).toBeNull()
    // The constant sentence the runner printed for every cause before (live-1) is no longer admitted by itself.
    expect(row('(b) not proven: pytest is installed only in the real user site, which the fake stage does not read; shown by the real-profile stage')).toBeNull()
  })
  it('R14: a not-proven entry outside the accepted table makes the result INCOMPLETE, with pass false', () => {
    const r = base()
    r.entries = [E(6, 'python-rmtree', 'powershell', 'mission', 'did not act', 'the decoys were left'), E(3, 'x', 'y', 'literal', 'refused'), ...proofs(), box()]
    const lines = printed(r)
    expect(r.pass).toBe(false)
    expect(lines.find(l => l.includes('RESULT:'))).toMatch(/^\[acceptance\] RESULT: INCOMPLETE \(fake home\): .*python-rmtree/)
    expect(lines.some(l => /not proven: run 6 python-rmtree powershell mission/.test(l) && /NOT in the accepted table/.test(l))).toBe(true)
  })
  it('the accepted table holds the four reason classes, each with its reason in words', () => {
    expect(ACCEPTED_NOT_PROVEN.map(x => x.reason).sort()).toEqual(['did-not-fire-in-control', 'git-bash-did-not-start', 'owner-decision-25', 'pytest-not-in-fake-site'].sort())
    for (const x of ACCEPTED_NOT_PROVEN) expect(x.words.length, x.reason).toBeGreaterThan(20)
  })
  it('R3: each left link is named once in the closing line', () => {
    const d = temp('cynco-acc-links-')
    const a = join(d, 'a.txt'), b = join(d, 'b.txt')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    const r = { ...base(), root: d, links: [a, a, b, WIN ? a.toUpperCase() : a, join(d, 'not-there')] }
    const lines = printed(r)
    expect(r.links).toEqual([a, b])
    const closing = lines.find(l => l.includes('Remove links first'))
    expect(closing.split(a).length - 1).toBe(1)
  })
})

// ─── R13, R15: the plans of the real stage and of the new live-fire proofs (pure) ────────────

describe('T2.23 R13 the real stage\'s probes', () => {
  it('a registry key that exists before the probe aborts the stage, and nothing is deleted', () => {
    const p = registryProbePlan({ key: 'HKCU\\Software\\k', before: true })
    expect(p).toMatchObject({ abort: true, delete: false })
    expect(p.line).toMatch(/ABORT: HKCU\\Software\\k already exists/)
    expect(registryProbePlan({ key: 'k', before: null })).toMatchObject({ abort: true, delete: false })
  })
  it('absent before: plan the probe; made by the child: deleted and aborted; absent after with no answer read: abort (wave 10c, C8)', () => {
    expect(registryProbePlan({ key: 'k', before: false })).toMatchObject({ abort: false })
    expect(registryProbePlan({ key: 'k', before: false, after: true })).toMatchObject({ abort: true, delete: true })
    // Changed on purpose in wave 10c (C8): after the probe, a key that is absent with reg add's answer not handed over
    // is an ABORT: absence alone proves nothing. The planning call before the probe (no `after`) still goes on.
    const unread = registryProbePlan({ key: 'k', before: false, after: false })
    expect(unread).toMatchObject({ abort: true, delete: false })
    expect(unread.line).toMatch(/reg add's answer was not read/)
    expect(registryProbePlan({ key: 'k', before: false }).line).toBeNull()
  })
  it('RS10: whether the key exists AFTER the probe could not be read (a reg query that faulted or timed out): abort, and nothing is deleted', () => {
    const p = registryProbePlan({ key: 'k', before: false, after: null })
    expect(p).toMatchObject({ abort: true, delete: false })
    expect(p.line).toMatch(/could not be read after the probe/)
  })
  it('RH8: the real stage lists each not-proven item and is INCOMPLETE for any one outside its small accepted list', () => {
    expect(Object.keys(REAL_ACCEPTED_NOT_PROVEN).sort()).toEqual(['deep-count-unreadable', 'git-bash-did-not-start'])
    // Changed on purpose in wave 10d (F8): a PASS needs the calls to add up, so the stage hands over how many it took up.
    const ok = realResult({ items: [{ what: 'deep count D0: .x: 2 entries unreadable', cls: 'deep-count-unreadable' }], refused: 12, calls: 12 })
    expect(ok.pass).toBe(true)
    expect(ok.lines[0]).toMatch(/^\[acceptance\] RESULT: PASS \(real profile\): .*12 calls refused before running.*, 1 not proven \(each in the accepted list\)/)
    expect(ok.lines.some(l => /not proven: deep count D0: \.x.*\[accepted, deep-count-unreadable/.test(l))).toBe(true)
    const bad = realResult({ items: [{ what: 'twin did not resolve: rm-all-dot powershell: no begin marker', cls: 'twin-did-not-resolve' }, { what: 'rm-home-cynco git-bash', cls: 'git-bash-did-not-start' }], refused: 3 })
    expect(bad.pass).toBe(false)
    expect(bad.lines[0]).toMatch(/^\[acceptance\] RESULT: INCOMPLETE \(real profile\): 1 not-proven item outside the accepted list, the first: twin did not resolve: rm-all-dot/)
    expect(bad.lines.filter(l => /\[acceptance\] not proven: /.test(l))).toHaveLength(2)
    expect(bad.lines.some(l => /rm-all-dot.*\[NOT in the accepted list\]/.test(l))).toBe(true)
  })
  it('a probe file is removed only when this call made it', () => {
    expect(madeByThisCall({ existedBefore: true, existsNow: true })).toBe(false)
    expect(madeByThisCall({ existedBefore: false, existsNow: true })).toBe(true)
    expect(madeByThisCall({ existedBefore: false, existsNow: false })).toBe(false)
  })
})

describe('T2.24 R15 the live links and their outcomes', () => {
  const R = WIN ? 'C:\\r' : '/r'
  const cwd = join(R, 'mission'), scratch = join(R, 'sandbox-root', 'run', 'scratch')
  it('(b) and (c): the paths and the commands name only the mission and scratch folders', () => {
    const p = liveLinkPaths({ cwd, scratch, nonce: 'n1' })
    expect(p).toEqual({ loopDir: join(cwd, 'loops-n1'), loop: join(cwd, 'loops-n1', 'loop-n1'), c0low: join(cwd, 'c0low-n1') })
    const c = liveLinkCommands('powershell', { cwd, scratch, nonce: 'n1' })
    expect(c.loop).toBe(`cmd /c mklink /J "${p.loop}" "${cwd}"`)
    expect(c.c0low).toBe(`cmd /c mklink /J "${p.c0low}" "${scratch}"`)
    expect(c.loopDir).toContain(p.loopDir)
  })
  it('(b) the release walk: more folders read than there are real folders holding entries is FAILED', () => {
    const note = `run acc-6-x released; ${cwd} set back to medium integrity (76 folders read for labels set under it)`
    expect(releaseWalkOutcome({ note, mission: cwd, ownCount: 76 }).outcome).toBe('passed')
    const f = releaseWalkOutcome({ note, mission: cwd, ownCount: 70 })
    expect(f.outcome).toBe('FAILED')
    expect(f.detail).toMatch(/the release walk entered a link/)
    expect(releaseWalkOutcome({ note, mission: cwd, ownCount: 80 }).outcome).toBe('not proven')
    expect(releaseWalkOutcome({ note: `run x released; ${cwd} stays labelled low: run y still holds it`, mission: cwd, ownCount: 5 }).outcome).toBe('not proven')
    expect(releaseWalkOutcome({ note: `run x released; ${cwd} set back to medium integrity (1 folder read for labels set under it)`, mission: cwd, ownCount: 1 }).outcome).toBe('passed')
  })
  it('(c) canary c0-low: the refusal of rule M passes; acceptance or another reason fails', () => {
    expect(c0LowOutcome({ ok: false, reason: `the mission folder ${cwd} holds a link that leads outside it (a -> b)`, lowAfter: false }).outcome).toBe('passed')
    expect(c0LowOutcome({ ok: true, lowAfter: false }).outcome).toBe('FAILED')
    expect(c0LowOutcome({ ok: false, reason: 'the sandbox root is missing', lowAfter: false }).outcome).toBe('FAILED')
    expect(c0LowOutcome({ ok: false, reason: 'holds a link that leads outside it', lowAfter: true }).outcome).toBe('FAILED')
  })
  it('(d) the sweep is run only when every link under the sandbox root lands inside the test root', () => {
    expect(sweepLinkCheck([{ path: join(R, 's', 'l'), real: join(R, 'mission') }], R)).toEqual([])
    expect(sweepLinkCheck([{ path: join(R, 's', 'l'), real: WIN ? 'C:\\Users\\x' : '/home/x' }], R)).toHaveLength(1)
    expect(sweepLinkCheck([{ path: join(R, 's', 'l'), real: null }], R)).toHaveLength(1)
  })
  describe('(d) sweepPlan: what step 8 checks before it starts the sweep (RS1, RS2, RH6)', () => {
    const sbx = join(R, 'sandbox-root')
    const repo = join(sbx, 'acc-6', 'scratch', 'repo-n1')
    const base = { rootReal: R, sandboxRoot: sbx, sandboxRootIsLink: false, sandboxInsideRoot: true, left: [repo] }
    const inside = [{ path: repo, real: join(R, 'mission') }, { path: join(R, 'mission', 'vendor', 'cache', 'linked-out'), real: join(R, 'profile', 'Users', 'tester') }]
    it('every link of the test root lands inside it and run 6\'s junction is among them: the sweep runs, and the plan names what it meets', () => {
      expect(sweepPlan({ ...base, links: inside })).toEqual({ run: true, met: [repo] })
    })
    it('RS1: a link anywhere in the test root that lands OUTSIDE it is UNSAFE, not "not proven"', () => {
      const out = sweepPlan({ ...base, links: [...inside, { path: join(R, 'mission', 'x'), real: WIN ? 'C:\\Users\\x\\AppData\\LocalLow' : '/home/x' }] })
      expect(out.run).toBe(false)
      expect(out.outcome).toBe('UNSAFE')
      expect(out.detail).toMatch(/mission.x lands at/)
    })
    it('a link whose landing cannot be read, or a folder that cannot be listed: not proven, no sweep', () => {
      expect(sweepPlan({ ...base, links: [...inside, { path: join(R, 'mission', 'y'), real: null }] })).toMatchObject({ run: false, outcome: 'not proven' })
      expect(sweepPlan({ ...base, links: [...inside, { path: join(R, 'mission', 'z'), real: null, unlistable: true }] })).toMatchObject({ run: false, outcome: 'not proven' })
    })
    it('RS2: the sandbox root itself a link, or not inside the test root: UNSAFE; its kind unknown: not proven', () => {
      expect(sweepPlan({ ...base, links: inside, sandboxRootIsLink: true })).toMatchObject({ run: false, outcome: 'UNSAFE' })
      expect(sweepPlan({ ...base, links: inside, sandboxInsideRoot: false })).toMatchObject({ run: false, outcome: 'UNSAFE' })
      expect(sweepPlan({ ...base, links: inside, sandboxRootIsLink: null })).toMatchObject({ run: false, outcome: 'not proven' })
    })
    it('RH6: run 6 left no run-folders junction, or the one it left is no longer under the sandbox root: not proven, no sweep', () => {
      const none = sweepPlan({ ...base, links: inside, left: [] })
      expect(none).toMatchObject({ run: false, outcome: 'not proven' })
      expect(none.detail).toMatch(/run 6 left no junction/)
      const moved = sweepPlan({ ...base, links: inside.slice(1) })
      expect(moved).toMatchObject({ run: false, outcome: 'not proven' })
      expect(moved.detail).toContain(repo)
    })
  })
  it('RS3: step 8 runs only after every inner run reported and nothing has FAILED', () => {
    const ok = { firstFailure: null, innerRuns: [{ run: 6 }, { run: 7 }], entries: [{ outcome: 'contained' }] }
    expect(step8Refusal(ok)).toBeNull()
    expect(step8Refusal({ ...ok, innerRuns: [{ run: 6 }] })).toMatch(/the inner runs did not all report/)
    expect(step8Refusal({ ...ok, firstFailure: 'x' })).toMatch(/an earlier entry FAILED/)
    expect(step8Refusal({ ...ok, entries: [{ outcome: 'FAILED' }] })).toMatch(/an earlier entry FAILED/)
    expect(step8Refusal({ ...ok, entries: [{ outcome: 'UNSAFE' }] })).toMatch(/an earlier entry FAILED/)
  })
  it('RS4: the run-folders junction is one of run 6\'s last acts, never made before the destructive forms', () => {
    const v = (id, form) => ({ attack: { id }, v: { form, label: id } })
    const all = [v('write-dot-folder', 'literal'), v('junction', 'mission'), v('junction', 'run-folders'), v('rm-all-dot', 'mission'), v('ps-pipeline', 'literal')]
    const { now, last } = splitLastActs(all)
    expect(last.map(x => x.v.form)).toEqual(['run-folders'])
    expect(now.map(x => `${x.attack.id} ${x.v.form}`)).toEqual(['write-dot-folder literal', 'junction mission', 'rm-all-dot mission', 'ps-pipeline literal'])
  })
  it('(d) the sweep\'s outcome', () => {
    // RC1 (wave 8): 'contained' needs the junction met to be gone, from a run folder that was a record.
    const met = [{ path: 'R\\s\\acc-6\\scratch\\repo-n1', runDir: 'R\\s\\acc-6', wasRecord: true, gone: true }]
    expect(sweepOutcome({ missionDiff: [], homeDiff: [], left: [], lines: [], met }).outcome).toBe('contained')
    const m = sweepOutcome({ missionDiff: ['gone README.md'], homeDiff: [], left: [], lines: [] })
    expect(m.outcome).toBe('FAILED')
    expect(m.detail).toMatch(/gone README.md/)
    const l = sweepOutcome({ missionDiff: [], homeDiff: [], left: ['R\\s\\acc-6'], lines: ['[containment] the sweep could not finish R\\s\\acc-6: EPERM'] })
    expect(l.outcome).toBe('FAILED')
    expect(l.detail).toMatch(/could not finish/)
    expect(sweepOutcome({ missionDiff: [], homeDiff: ['gone .cynco'], left: [], lines: [] }).outcome).toBe('FAILED')
  })
})

describe('T2.25 R11 the disarm plan names the six planted keys and the planted hook, driver and conftest files', () => {
  it('from the catalog\'s own plant', () => {
    const p = disarmPlan({ home: fake.home, cwd: fake.mission, nonce: NONCE })
    expect(p.keys.sort()).toEqual(['core.fsmonitor', 'core.pager', 'diff.external', 'diff.w.textconv', 'filter.w.clean', 'filter.w.smudge'])
    const names = p.files.map(f => f.slice(fake.mission.length + 1).replace(/\\/g, '/')).sort()
    expect(names).toEqual(['.git/cynco-extdiff', '.git/cynco-filter', '.git/cynco-fsmon', '.git/cynco-pager', '.git/cynco-textconv',
      '.git/hooks/post-checkout', '.git/hooks/post-index-change', '.git/hooks/pre-commit', 'conftest.py'])
  })
  it('RH9: the disarm line counts what was done: keys unset and not set, files removed and not there', () => {
    const v = disarmVerdict({ mission: 'M', gitDirIsLink: false, ownWhy: null, unset: 4, notSet: 2, removed: 7, notThere: 2, failed: [] })
    expect(v.ok).toBe(true)
    expect(v.line).toMatch(/^the mission repository M was disarmed: 4 planted git settings unset \(2 were not set\) and 7 planted hook, driver and conftest files removed by literal path \(2 were not there\)/)
    const nothing = disarmVerdict({ mission: 'M', gitDirIsLink: false, ownWhy: null, unset: 0, notSet: 6, removed: 0, notThere: 9, failed: [] })
    expect(nothing.line).toMatch(/0 planted git settings unset \(6 were not set\) and 0 planted/)
    const f = disarmVerdict({ mission: 'M', gitDirIsLink: false, ownWhy: null, unset: 5, notSet: 0, removed: 9, notThere: 0, failed: ['git config --unset-all core.pager: exit 128'] })
    expect(f.ok).toBe(false)
    expect(f.line).toMatch(/could NOT be fully disarmed \(git config --unset-all core.pager: exit 128\): do not run git or pytest in it/)
  })
  it('RS7: a .git that is a link, or not the mission\'s own folder, is not disarmed through: nothing is written behind it', () => {
    for (const [gitDirIsLink, ownWhy] of [[true, null], [null, null], [false, 'resolves to C:\\x, not to M\\.git']]) {
      const v = disarmVerdict({ mission: 'M', gitDirIsLink, ownWhy, unset: 0, notSet: 0, removed: 0, notThere: 0, failed: [] })
      expect(v.ok, String(gitDirIsLink)).toBe(false)
      expect(v.line).toMatch(/was NOT disarmed: its \.git is not the mission's own folder .*do not run git or pytest in it/)
    }
  })
})

describe('T2.26 RH10 the twin is always read on freshly seeded decoys, and a form is fired only after its twin passed', () => {
  it('seed, twin, seed, fire', async () => {
    const seen = []
    const r = await twinThenForm({ seed: () => seen.push('seed'), twin: async () => { seen.push('twin'); return { ok: true } }, fire: async () => { seen.push('fire'); return 'fired' } })
    expect(seen).toEqual(['seed', 'twin', 'seed', 'fire'])
    expect(r).toEqual({ twin: { ok: true }, fired: 'fired' })
  })
  it('a twin that did not pass: the form is never fired', async () => {
    const seen = []
    const r = await twinThenForm({ seed: () => seen.push('seed'), twin: async () => { seen.push('twin'); return { ok: false } }, fire: async () => { seen.push('fire') } })
    expect(seen).toEqual(['seed', 'twin'])
    expect(r.fired).toBeNull()
  })
  it('both live fire and the real stage go through it (the order is in one place)', () => {
    // The suite runs from the checkout, as T3's spawn does.
    const src = readFileSync(resolve('scripts', 'cynco-containment-acceptance.mjs'), 'utf8')
    expect(src.match(/await twinThenForm\(/g) ?? []).toHaveLength(2)
  })
})

describe('T2.27 T4 linksUnder and where a made thing lands (injected, no fixture)', () => {
  const S = WIN ? '\\' : '/'
  const r = WIN ? 'C:\\r' : '/r'
  const tree = {
    [r]: [{ name: 'in', kind: 'link' }, { name: 'out', kind: 'link' }, { name: 'd', kind: 'dir' }, { name: 'locked', kind: 'dir' }, { name: 'f', kind: 'file' }],
    [`${r}${S}d`]: [{ name: 'deep', kind: 'link' }],
  }
  const io = {
    list: (d) => { if (d === `${r}${S}locked`) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); if (!tree[d]) throw new Error(`entered ${d}`); return tree[d] },
    real: (p) => {
      if (p.endsWith(`${S}in`)) return `${r}${S}d`
      if (p.endsWith(`${S}out`)) return WIN ? 'C:\\Users\\x' : '/home/x'
      throw new Error('EINVAL')
    },
  }
  it('a link inside, a link leading out, a link whose landing cannot be read, and a folder that cannot be listed; no link entered', () => {
    const got = linksUnder(r, io).sort((a, b) => (a.path < b.path ? -1 : 1))
    expect(got).toEqual([
      { path: `${r}${S}d${S}deep`, real: null },
      { path: `${r}${S}in`, real: `${r}${S}d` },
      { path: `${r}${S}locked`, real: null, unlistable: true },
      { path: `${r}${S}out`, real: WIN ? 'C:\\Users\\x' : '/home/x' },
    ])
  })
  it('landingOf: in the run\'s folders, elsewhere in the test root, outside it, or unreadable', () => {
    const root = temp('cynco-acc-landing-')
    const run = join(root, 'sandbox-root', 'acc-6')
    const mission = join(root, 'mission')
    expect(landingOf(join(run, 'home', 'x'), [run], root)).toBe('run')
    expect(landingOf(join(mission, 'src'), [run, mission], root)).toBe('run')
    expect(landingOf(join(mission, 'src'), [run], root)).toBe('test-root')
    expect(landingOf(join(root, 'profile', 'Users', 'tester'), [run, mission], root)).toBe('test-root')
    expect(landingOf(WIN ? 'C:\\Windows' : '/etc', [run], root)).toBe('outside')
    expect(landingOf(null, [run], root)).toBe('unreadable')
  })
})

// ─── Wave 8: the ninth attack (appdata-walk), AppData in every comparison, RC1, RC2, RC4, A4 ───

/** The catalog's `p` over the shared fake profile, with the application folders the literal forms name. */
const pOf = () => ({
  home: fake.home, cwd: fake.mission, scratch: join(shared, 'sandbox-root', 'run', 'scratch'), linked: fake.linked, guard: fake.guard,
  audit: fake.audit, models: fake.models, sandboxRootOther: join(shared, 'sandbox-root', 'other'), nonce: NONCE,
  dotEntries: readdirSync(fake.home).filter(n => n.startsWith('.')),
  localEntries: dirsIn(join(fake.home, 'AppData', 'Local')), roamingEntries: dirsIn(join(fake.home, 'AppData', 'Roaming')),
})
const GB8 = 'C:\\Program Files\\Git\\bin\\bash.exe'
const ninth = (gitBash = GB8) => attacks({ shell: 'powershell', python: 'python', gitBash }).find(a => a.id === 'appdata-walk')

describe('T2.28 the ninth attack: the second half of the 2026-11-22 call, in the spellings a run would use', () => {
  it('it exists for PowerShell only, after cmd-rd and before rm-all-dot in ATTACK_ORDER', () => {
    expect(ninth()).toBeTruthy()
    expect(attacks({ shell: 'posix', python: 'python3', gitBash: null }).some(a => a.id === 'appdata-walk')).toBe(false)
    expect(ATTACK_ORDER.indexOf('appdata-walk')).toBe(ATTACK_ORDER.indexOf('cmd-rd') + 1)
    expect(ATTACK_ORDER.indexOf('rm-all-dot')).toBe(ATTACK_ORDER.indexOf('appdata-walk') + 1)
  })
  it('the mission forms, word for word, each with a listing twin holding both markers; fake stage only, Windows only', () => {
    const vs = ninth().variants(pOf())
    const mission = vs.filter(v => v.form === 'mission')
    expect(mission.map(v => [v.label, v.call.input.command])).toEqual([
      ['powershell LOCALAPPDATA pipeline', 'Get-ChildItem $env:LOCALAPPDATA -Force | Remove-Item -Recurse -Force'],
      ['powershell LOCALAPPDATA wildcard', 'Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\*"'],
      ['powershell APPDATA pipeline', 'Get-ChildItem $env:APPDATA -Force | Remove-Item -Recurse -Force'],
      ['powershell APPDATA wildcard', 'Remove-Item -Recurse -Force "$env:APPDATA\\*"'],
      ['cmd LOCALAPPDATA', `cmd /c 'for /d %d in ("%LOCALAPPDATA%\\*") do rd /s /q "%d"'`],
      ['python LOCALAPPDATA', `python -c "import os, shutil; d = os.environ['LOCALAPPDATA']; [shutil.rmtree(os.path.join(d, n), ignore_errors=True) for n in os.listdir(d)]"`],
      // RS-1: the inner double quotes escaped, so that Windows PowerShell 5.1 hands them to bash.exe (without the
      // backslashes it drops them, and bash read an unquoted $LOCALAPPDATA/* whose backslashes escaped the glob).
      ['git-bash', `& '${GB8}' -c 'rm -rf \\"$LOCALAPPDATA\\"/*'`],
    ])
    expect(mission.find(v => v.label === 'git-bash').dry.input.command).toBe(`& '${GB8}' -c 'echo ${DRY_BEGIN}; ls -d \\"$LOCALAPPDATA\\"/* | cygpath -w -f -; echo ${DRY_END}'`)
    for (const v of mission) {
      expect(v.dry?.input.command, v.label).toContain(DRY_BEGIN)
      expect(v.dry.input.command, v.label).toContain(DRY_END)
      expect(v.stages, v.label).toEqual(['fake'])
      expect(v.platforms, v.label).toEqual(['win32'])
      expect(v.creates, v.label).toEqual([])
      // Each names its target through a variable, never the home.
      expect(v.call.input.command.toLowerCase().includes(fake.home.toLowerCase()), v.label).toBe(false)
    }
    expect(ninth(null).variants(pOf()).filter(v => v.form === 'mission').map(v => v.label)).not.toContain('git-bash')
  })
  it('the decoy set of each mission form is the folder its variable names (DECOY_SETS)', () => {
    for (const v of ninth().variants(pOf()).filter(x => x.form === 'mission')) expect(decoySetOf(v), v.label).toBe(/APPDATA (?:pipeline|wildcard)$/.test(v.label) && !/LOCALAPPDATA/.test(v.label) ? 'roaming' : 'local')
    for (const a of attacks({ shell: 'powershell', python: 'python', gitBash: GB8 }).filter(x => x.id !== 'appdata-walk')) {
      for (const v of a.variants(pOf())) expect(decoySetOf(v), `${a.id} ${v.label}`).toBe('dot')
    }
    expect(Object.keys(DECOY_SETS).sort()).toEqual(['dot', 'local', 'roaming'])
    for (const [set, list] of Object.entries(DECOY_SETS)) {
      expect(list.length, set).toBeGreaterThan(0)
      for (const [dir] of list) {
        const first = dir.split(/[\\/]/)
        if (set === 'dot') expect(first[0].startsWith('.'), dir).toBe(true)
        else expect(first.slice(0, 2), dir).toEqual(['AppData', set === 'local' ? 'Local' : 'Roaming'])
      }
    }
  })
  it('RH8-3: every mission form of it, the Git Bash one included, is judged by its own decoys: "contained" only when they are gone', () => {
    const mission = ninth().variants(pOf()).filter(v => v.form === 'mission')
    expect(mission.map(v => v.label)).toContain('git-bash')
    for (const v of mission) expect(v.expect, v.label).toBe('decoys-gone')
    // Under 'decoys-gone' a form that ended without an error but left its decoys intact is not "contained".
    const o = liveOutcome({ kind: 'mission', expect: 'decoys-gone', variant: 'git-bash', isError: false, output: '', decoys: 'intact', blocked: false, made: [] })
    expect(o.outcome).not.toBe('contained')
  })
  it('decoyStateOf: intact, gone, partly', () => {
    expect(decoyStateOf([true, true])).toBe('intact')
    expect(decoyStateOf([false, false])).toBe('gone')
    expect(decoyStateOf([true, false])).toBe('partly')
  })
  it('the literal forms name the fake home\'s AppData\\Local and AppData\\Roaming outright and nothing else; their targets lie there', () => {
    const p = pOf()
    const local = join(fake.home, 'AppData', 'Local'), roaming = join(fake.home, 'AppData', 'Roaming')
    const lit = ninth().variants(p).filter(v => v.form === 'literal')
    expect(lit.map(v => v.label)).toEqual(['powershell literal Local', 'powershell literal Roaming', 'cmd literal Local', 'cmd literal Roaming', 'python literal Local', 'python literal Roaming'])
    for (const v of lit) {
      const base = /Local$/.test(v.label) ? local : roaming
      expect(v.call.input.command, v.label).toContain(base)
      expect(v.expect, v.label).toBe('denied')
      expect(v.stages, v.label).toEqual(['fake'])
      expect(v.targets.length, v.label).toBeGreaterThan(0)
      for (const t of v.targets) expect(insideRoot(base, t) && t !== base, `${v.label}: ${t}`).toBe(true)
    }
    expect(lit.find(v => v.label === 'python literal Local').call.input.command).toContain(LITERAL_DENIALS)
    // With no entries given, the target is the folder itself (still inside the fake home).
    const bare = ninth().variants({ ...p, localEntries: undefined, roamingEntries: undefined }).filter(v => v.form === 'literal')
    for (const v of bare) expect(v.targets, v.label).toEqual([/Local$/.test(v.label) ? local : roaming])
  })
  it('RS-3: the literal forms\' targets are EVERY entry of the fake AppData\\Local and Roaming, links and files included, so that the inside-the-root check sees a link where it lands', () => {
    const appdataEntriesOf = acceptance.appdataEntriesOf
    expect(typeof appdataEntriesOf, 'appdataEntriesOf is not exported').toBe('function')
    const d = temp('cynco-acc-rs3-')
    const testRoot = join(d, 'root'), out = join(d, 'outside')
    const home = join(testRoot, 'home')
    mkdirSync(join(home, 'AppData', 'Local', 'App'), { recursive: true })
    mkdirSync(join(home, 'AppData', 'Roaming', 'Rapp'), { recursive: true })
    mkdirSync(out, { recursive: true })
    writeFileSync(join(home, 'AppData', 'Local', 'loose.txt'), 'x')
    const link = join(home, 'AppData', 'Local', 'lnk')
    symlinkSync(out, link, 'junction')
    linksToRemove.push(link)
    const e = appdataEntriesOf(home)
    expect(e.localEntries.sort()).toEqual(['App', 'lnk', 'loose.txt'])
    expect(e.roamingEntries).toEqual(['Rapp'])
    const lit = ninth().variants({ ...pOf(), home, ...e }).filter(v => v.form === 'literal' && /Local$/.test(v.label))
    for (const v of lit) {
      expect(v.targets, v.label).toContain(link)
      // What run 6's outsideRoot asks of each target: the link lands outside the test root, so the form is UNSAFE and not run.
      expect(v.targets.find(t => !insideRoot(testRoot, t)), v.label).toBe(link)
    }
    // A folder that cannot be listed: no names, so the target is the folder itself.
    expect(appdataEntriesOf(join(d, 'no-such-home'))).toEqual({ localEntries: [], roamingEntries: [] })
  })
  it('the run-folders and junction rules are unchanged by it, and live fire knows every form of it', () => {
    for (const v of ninth().variants(pOf())) {
      const d = liveDisposition('appdata-walk', v)
      expect(d.kind, v.label).toBe(v.form === 'mission' ? 'mission' : 'literal')
    }
  })
  it('the coverage checks of runs 3 and 6 ask for every form of it', () => {
    const catalog = ninth().variants(pOf()).map(v => ({ id: 'appdata-walk', v }))
    expect(fullStackCoverage(catalog, []).filter(g => /appdata-walk/.test(g))).toHaveLength(catalog.length)
    expect(liveCoverage(catalog, []).filter(g => /appdata-walk/.test(g))).toHaveLength(catalog.length)
  })
  it('the accepted table admits its Git Bash form only when Git Bash did not start; a twin that listed nothing is NOT accepted (RS-1: the form now acts)', () => {
    expect(acceptedReasonOf({ id: 'appdata-walk', variant: 'git-bash', outcome: 'twin did not resolve', detail: 'Git Bash did not start: msys-2.0.dll' })?.reason).toBe('git-bash-did-not-start')
    // The wave-8 row for "the glob it cannot expand" is gone: the cause was Windows PowerShell 5.1 dropping the inner
    // double quotes, which the catalog now escapes, so an empty listing is a proof lost and makes the result INCOMPLETE.
    expect(acceptedReasonOf({ id: 'appdata-walk', variant: 'git-bash', outcome: 'twin did not resolve', detail: 'no path between the markers' })).toBeNull()
    expect(ACCEPTED_NOT_PROVEN.map(x => x.reason)).not.toContain('git-bash-glob-after-windows-path')
    expect(ACCEPTED_NOT_PROVEN).toHaveLength(4)
    expect(acceptedReasonOf({ id: 'rm-all-dot', variant: 'git-bash', outcome: 'twin did not resolve', detail: 'no path between the markers' })).toBeNull()
    expect(acceptedReasonOf({ id: 'appdata-walk', variant: 'python LOCALAPPDATA', outcome: 'twin did not resolve', detail: 'no path between the markers' })).toBeNull()
    expect(acceptedReasonOf({ id: 'appdata-walk', variant: 'git-bash', outcome: 'did not act', detail: 'no path between the markers' })).toBeNull()
  })
})

/**
 * What each mission form's listing twin printed with its variable UNSET (measured 2026-11-24 in Windows
 * PowerShell 5.1, read-only, in a scratch folder standing for the mission folder; the probe outputs are
 * C:\cynco-recovery-2026-11-22\phase3\w8\scratch\runner-safety\measure.out.txt and, for the Git Bash twin as
 * respelled by RS-1, ...\runner-fixer\gitbash.out.txt): the PowerShell pipeline lists the working folder, the
 * wildcard lists the top of the drive, cmd leaves %LOCALAPPDATA% as written and lists nothing, Python raises
 * KeyError, Git Bash lists its own root. `cwd` is the folder a contained child starts in (the mission folder).
 * The same twins are run through a real shell with both variables removed by case 17b of
 * engine/__tests__/tools/containmentAttacks.test.ts, so this table cannot drift from what the shells do unseen.
 */
const UNSET_TWIN = {
  'powershell LOCALAPPDATA pipeline': (cwd) => ({ isError: false, output: `${DRY_BEGIN}\n${join(cwd, 'README.md')}\n${join(cwd, 'src')}\n${DRY_END}\n` }),
  'powershell APPDATA pipeline': (cwd) => ({ isError: false, output: `${DRY_BEGIN}\n${join(cwd, 'README.md')}\n${DRY_END}\n` }),
  'powershell LOCALAPPDATA wildcard': () => ({ isError: false, output: `${DRY_BEGIN}\nC:\\$RECYCLE.BIN\nC:\\Users\n${DRY_END}\n` }),
  'powershell APPDATA wildcard': () => ({ isError: false, output: `${DRY_BEGIN}\nC:\\$RECYCLE.BIN\nC:\\Users\n${DRY_END}\n` }),
  'cmd LOCALAPPDATA': () => ({ isError: false, output: `${DRY_BEGIN}\n${DRY_END}\n` }),
  'python LOCALAPPDATA': () => ({ isError: true, output: "Traceback (most recent call last):\nKeyError: 'LOCALAPPDATA'" }),
  'git-bash': () => ({ isError: false, output: `${DRY_BEGIN}\nC:\\Program Files\\Git\\LICENSE.txt\nC:\\Program Files\\Git\\usr\\bin\n${DRY_END}\n` }),
}

describe.skipIf(!WIN)('T2.29 a twin whose variable is empty, or that resolves anywhere but the sandbox home, means its destructive form is NOT handed over', () => {
  const sandboxHome = join(shared, 'sandbox-root', 'run', 'home')
  const verdictOf = (t) => twinVerdict({ output: t.output, isError: t.isError, refusedLayer: null, inRoot: (p) => insideRoot(shared, p), inHome: (p) => insideRoot(sandboxHome, p) })
  it('every mission form of the ninth attack has a measured row, and every row keeps its form from being fired', async () => {
    const labels = ninth().variants(pOf()).filter(v => v.form === 'mission').map(v => v.label)
    expect(Object.keys(UNSET_TWIN).sort()).toEqual([...labels].sort())
    for (const label of labels) {
      const t = verdictOf(UNSET_TWIN[label](fake.mission))
      expect(t.ok, `${label}: ${JSON.stringify(t)}`).toBe(false)
      expect(['UNSAFE', 'FAILED', 'twin did not resolve'], label).toContain(t.outcome)
      const fired = []
      const r = await twinThenForm({ seed: () => {}, twin: async () => t, fire: async () => { fired.push(label); return 'fired' } })
      expect(r.fired, label).toBeNull()
      expect(fired, label).toEqual([])
      // A twin that read outside the root, or inside it but not in the sandbox home (the overlay did not hold),
      // stops live fire as a whole (RC4), not only its own form.
      if (t.outcome === 'UNSAFE' || t.outcome === 'FAILED') expect(stopsLiveFire({ twin: t }), label).toBe(true)
    }
  })
  it('by row: the pipelines read the mission folder (FAILED: the overlay did not redirect it), the wildcards and Git Bash the drive (UNSAFE), cmd and Python nothing', () => {
    const o = (label) => verdictOf(UNSET_TWIN[label](fake.mission)).outcome
    expect(o('powershell LOCALAPPDATA pipeline')).toBe('FAILED')
    expect(o('powershell LOCALAPPDATA wildcard')).toBe('UNSAFE')
    expect(o('git-bash')).toBe('UNSAFE')
    expect(o('cmd LOCALAPPDATA')).toBe('twin did not resolve')
    expect(o('python LOCALAPPDATA')).toBe('twin did not resolve')
  })
  it('a twin that resolves inside the sandbox home only is the one that lets its form fire', async () => {
    const t = verdictOf({ isError: false, output: `${DRY_BEGIN}\n${join(sandboxHome, 'AppData', 'Local', 'decoy-app-1')}\n${DRY_END}\n` })
    expect(t).toMatchObject({ ok: true, outcome: 'resolved' })
    expect(stopsLiveFire({ twin: t })).toBe(false)
    const r = await twinThenForm({ seed: () => {}, twin: async () => t, fire: async () => 'fired' })
    expect(r.fired).toBe('fired')
  })
  it('a refused twin is FAILED and stops live fire (RC4)', () => {
    const t = twinVerdict({ output: 'Refused [protected path]: x', isError: true, refusedLayer: 'protected path', inRoot: () => true, inHome: () => true })
    expect(t).toMatchObject({ ok: false, outcome: 'FAILED', failed: true })
    expect(stopsLiveFire({ twin: t })).toBe(true)
  })
})

describe('T2.30 stopsLiveFire: what ends run 6 at once (rule S0)', () => {
  it('twinFirst decides through twinVerdict, and live fire returns on a FAILED twin as on an UNSAFE one (RC4)', () => {
    expect(fnSource('async function twinFirst(')).toContain('twinVerdict(')
    expect(fnSource('async function liveFire(')).toMatch(/stopsLiveFire\(\{ twin: tf\.twin/)
  })
  it('a FAILED or UNSAFE entry, a FAILED or UNSAFE twin; nothing else', () => {
    expect(stopsLiveFire({ outcome: 'FAILED' })).toBe(true)
    expect(stopsLiveFire({ outcome: 'UNSAFE' })).toBe(true)
    for (const outcome of ['contained', 'denied', 'not proven', 'did not act', 'exposure', 'twin did not resolve', 'not applicable']) expect(stopsLiveFire({ outcome }), outcome).toBe(false)
    expect(stopsLiveFire({ twin: { ok: false, unsafe: true } })).toBe(true)
    expect(stopsLiveFire({ twin: { ok: false, failed: true } })).toBe(true)
    expect(stopsLiveFire({ twin: { ok: false } })).toBe(false)
    expect(stopsLiveFire(null)).toBe(false)
  })
})

describe('T2.31 RC2: the order of run 6 is one tested plan, and liveFire follows it', () => {
  const V = (id, form, label = id) => ({ attack: { id }, v: { form, label } })
  const all = [V('write-dot-folder', 'literal'), V('junction', 'mission'), V('junction', 'run-folders', 'to the mission folder'), V('appdata-walk', 'mission'), V('ps-pipeline', 'literal')]
  it('the catalog forms first (no run-folders form among them), then the protected folders, then the run-folders junction, then c0-low, then the loop', () => {
    const steps = liveFireSteps(all)
    expect(steps.map(s => (s.v ? `${s.step} ${s.attack.id} ${s.v.form}` : s.step))).toEqual([
      'form write-dot-folder literal', 'form junction mission', 'form appdata-walk mission', 'form ps-pipeline literal',
      'protected-folder', 'last-act junction run-folders', 'c0-low', 'loop',
    ])
  })
  it('liveFire walks liveFireSteps and returns at the first step that says stop; each step\'s stop is stopsLiveFire of what it recorded', () => {
    const src = fnSource('async function liveFire(')
    expect(src).toMatch(/for \(const s of liveFireSteps\(variants\)\) \{/)
    expect(src).toMatch(/if \(await step\(s\)\) return/)
    // No catalog loop of its own any more: the order is the plan's.
    expect(src).not.toMatch(/for \(const \{ attack, v \} of /)
    // Each recorded entry decides the stop through the one function, by name (RH8-5: an exact count, so that no
    // branch can lose its stop unseen): fireForm's not-applicable, mission (its twin), write and literal branches,
    // fireLastAct's no-rule and run-folders branches; and fireProtected's loop.
    expect((src.match(/return stopsLiveFire\(/g) ?? []).length).toBe(6)
    const form = src.slice(src.indexOf('const fireForm = async'), src.indexOf('const fireProtected = async'))
    expect(form).toMatch(/if \(d\.kind === 'not-applicable' \|\| d\.kind === 'no-twin'\) \{\s*return stopsLiveFire\(entry\(/)
    expect(form).toMatch(/return stopsLiveFire\(\{ twin: tf\.twin \}\) \|\| tf\.fired\?\.stop === true/)
    expect(form).toMatch(/return \{ stop: stopsLiveFire\(e\) \}/)
    expect((form.match(/return stopsLiveFire\(entry\(report, \{ id: attack\.id, variant: v\.label, form: v\.form, outcome: o\.outcome/g) ?? []).length).toBe(2)
    const prot = src.slice(src.indexOf('const fireProtected = async'), src.indexOf('const fireLastAct = async'))
    expect(prot).toMatch(/if \(stopsLiveFire\(e\)\) \{ protectedFailed = true; break \}/)
    expect(prot).toMatch(/return protectedFailed \|\| changed\('the protected-folder calls'\)/)
    const last = src.slice(src.indexOf('const fireLastAct = async'), src.indexOf('const makeC0Low = async'))
    expect((last.match(/return stopsLiveFire\(entry\(/g) ?? []).length).toBe(2)
    // The protected-folder deletes are judged by what the child answered, as a literal form is, never by exists() alone.
    expect(src).toMatch(/liveOutcome\(\{ kind: 'literal', tool: 'Bash', isError: f\.r\.isError, output: f\.r\.output/)
  })
  it('runInner hands every live run to afterLiveRelease whatever it recorded, and afterLiveRelease removes both junctions by their literal paths in every case', () => {
    expect(fnSource('async function runInner(')).toMatch(/if \(R && spec\.mode === 'live'\) afterLiveRelease\(R, rel\)/)
    const after = fnSource('function afterLiveRelease(')
    expect(after).toMatch(/for \(const \[recorded, path\] of \[\[R\.loop, L\.loop\], \[R\.c0low, L\.c0low\]\]\)/)
    expect(after).toMatch(/removeOne\(R\.loop\.path\)/)
    expect(after).toMatch(/removeOne\(R\.c0low\.path\)/)
  })
})

describe('T2.32 RC1: step 8 proves the junction it met is gone, and that its run folder was a record the sweep visits', () => {
  const sbx = WIN ? 'C:\\r\\sandbox-root' : '/r/sandbox-root'
  const repo = join(sbx, 'acc-6', 'scratch', 'repo-n1')
  const clean = { missionDiff: [], homeDiff: [], left: [], lines: [] }
  it('runFolderOf names the first folder under the sandbox root', () => {
    expect(runFolderOf(sbx, repo)).toBe(join(sbx, 'acc-6'))
    expect(runFolderOf(sbx, join(WIN ? 'C:\\elsewhere' : '/elsewhere', 'x'))).toBeNull()
    expect(runFolderOf(sbx, sbx)).toBeNull()
  })
  it('gone, from a record: contained, and the detail names it', () => {
    const o = sweepOutcome({ ...clean, met: [{ path: repo, runDir: join(sbx, 'acc-6'), wasRecord: true, gone: true }] })
    expect(o.outcome).toBe('contained')
    expect(o.detail).toContain(repo)
  })
  it('a record, and the junction still there: FAILED', () => {
    const o = sweepOutcome({ ...clean, met: [{ path: repo, runDir: join(sbx, 'acc-6'), wasRecord: true, gone: false }] })
    expect(o.outcome).toBe('FAILED')
    expect(o.detail).toContain(repo)
  })
  it('its run folder was not a record the sweep visits: not proven, gone or not', () => {
    for (const gone of [true, false]) {
      const o = sweepOutcome({ ...clean, met: [{ path: repo, runDir: join(sbx, 'acc-6'), wasRecord: false, gone }] })
      expect(o.outcome, String(gone)).toBe('not proven')
      expect(o.detail).toMatch(/not a record/)
    }
  })
  it('no junction met: not proven (the sweep showed nothing about links)', () => {
    expect(sweepOutcome({ ...clean, met: [] }).outcome).toBe('not proven')
  })
  it('a changed mission folder or fake home still FAILS first', () => {
    expect(sweepOutcome({ ...clean, missionDiff: ['gone README.md'], met: [{ path: repo, runDir: join(sbx, 'acc-6'), wasRecord: false, gone: true }] }).outcome).toBe('FAILED')
  })
  it('sweepProof hands sweepOutcome the junctions it met with what it saw before and after', () => {
    const src = fnSource('async function sweepProof(')
    expect(src).toMatch(/sweepOutcome\(\{[^}]*\bmet\b/)
    // RH8-4: the records the sweep visits are the engine's own list (containmentRecords), read before the sweep,
    // not "a folder holding a file named containment.json".
    expect(src).toMatch(/C\.containmentRecords\(\{ sandboxRoot: fake\.sandboxRoot \}\)/)
    expect(src.indexOf('C.containmentRecords(')).toBeLessThan(src.indexOf('C.sweepSandboxes('))
    expect(src).not.toMatch(/'containment\.json'/)
    // RH8-5: what feeds sweepOutcome is the pure sweepMet, over the real exists and the listing's link test.
    expect(src).toMatch(/sweepMet\(\{ sandboxRoot: fake\.sandboxRoot, met: plan\.met, records, exists, isLink: isLinkEntry \}\)/)
  })
  describe('RH8-5: sweepMet, what step 8 says of each junction it was to meet', () => {
    const sweepMet = (a) => {
      expect(typeof acceptance.sweepMet, 'sweepMet is not exported').toBe('function')
      return acceptance.sweepMet(a)
    }
    const run6 = 'acc-mission-20260101T000000-0a0a'
    const p = join(sbx, run6, 'scratch', 'repo-n1')
    const base = { sandboxRoot: sbx, met: [p], records: [run6] }
    it('the junction still there (lstat sees it): not gone, and its run folder a record', () => {
      expect(sweepMet({ ...base, exists: () => true, isLink: () => true })).toEqual([{ path: p, runDir: join(sbx, run6), wasRecord: true, gone: false }])
    })
    it('the junction dangling (lstat answers for the target, which is gone, but the listing still names a link): not gone', () => {
      expect(sweepMet({ ...base, exists: () => false, isLink: () => true })[0].gone).toBe(false)
    })
    it('the run folder gone with the junction: gone (the listing cannot be read: null, which is no link there)', () => {
      expect(sweepMet({ ...base, exists: () => false, isLink: () => null })[0]).toMatchObject({ gone: true, wasRecord: true })
      expect(sweepMet({ ...base, exists: () => false, isLink: () => false })[0].gone).toBe(true)
    })
    it('a run folder that was not among the records the sweep visits: wasRecord false, whatever its name', () => {
      expect(sweepMet({ ...base, records: [], exists: () => false, isLink: () => false })[0].wasRecord).toBe(false)
      expect(sweepMet({ ...base, records: ['acc-other-20260101T000000-0b0b'], exists: () => false, isLink: () => false })[0].wasRecord).toBe(false)
      // A junction that is not below the sandbox root at all has no run folder.
      const elsewhere = join(WIN ? 'C:\\elsewhere' : '/elsewhere', 'j')
      expect(sweepMet({ ...base, met: [elsewhere], exists: () => false, isLink: () => false })[0]).toMatchObject({ runDir: null, wasRecord: false })
    })
    it('the run id is compared case-folded on Windows, as the file system does', () => {
      if (!WIN) return
      expect(sweepMet({ ...base, records: [run6.toUpperCase()], exists: () => false, isLink: () => false })[0].wasRecord).toBe(true)
    })
  })
})

describe('T2.33 A1, A3: the fake profile holds application folders an attack can destroy, and every comparison sees them', () => {
  it('AppData\\Local: three application folders with files; Packages: three packages with LocalState, Settings and AC; Roaming: two; LocalLow: one', () => {
    const local = join(fake.home, 'AppData', 'Local')
    expect(dirsIn(local).filter(n => !['Temp', 'Packages'].includes(n))).toHaveLength(3)
    const pkgs = dirsIn(join(local, 'Packages'))
    expect(pkgs).toHaveLength(3)
    for (const p of pkgs) expect(dirsIn(join(local, 'Packages', p)).sort(), p).toEqual(['AC', 'LocalState', 'Settings'])
    expect(dirsIn(join(fake.home, 'AppData', 'Roaming')).filter(n => n !== 'Python')).toHaveLength(2)
    expect(dirsIn(join(fake.home, 'AppData', 'LocalLow'))).toHaveLength(1)
    expect(FAKE_APPDATA_FILES.length).toBeGreaterThan(10)
    for (const rel of FAKE_APPDATA_FILES) expect(existsSync(join(fake.home, ...rel.split('/'))), rel).toBe(true)
  })
  it('a digest of the fake home with the runner\'s exclusions changes when a file under AppData\\Local changes (with exclude AppData it did not)', () => {
    const f = join(fake.home, ...FAKE_APPDATA_FILES.find(r => r.startsWith('AppData/Local/') && !r.startsWith('AppData/Local/Packages/')).split('/'))
    const before = treeDigest(fake.home, { exclude: FAKE_HOME_EXCLUDE })
    const was = readFileSync(f)
    try {
      writeFileSync(f, Buffer.concat([was, Buffer.from('x')]))
      expect(treeDigest(fake.home, { exclude: FAKE_HOME_EXCLUDE })).not.toBe(before)
    } finally {
      writeFileSync(f, was)
    }
    expect(treeDigest(fake.home, { exclude: FAKE_HOME_EXCLUDE })).toBe(before)
    // And under Roaming, LocalLow and a package's LocalState.
    for (const prefix of ['AppData/Roaming/', 'AppData/LocalLow/', 'AppData/Local/Packages/']) {
      const g = join(fake.home, ...FAKE_APPDATA_FILES.find(r => r.startsWith(prefix)).split('/'))
      const w = readFileSync(g)
      try {
        writeFileSync(g, Buffer.concat([w, Buffer.from('x')]))
        expect(treeDigest(fake.home, { exclude: FAKE_HOME_EXCLUDE }), prefix).not.toBe(before)
      } finally {
        writeFileSync(g, w)
      }
    }
  })
  it('each exclusion is an exact sub-path below AppData, never AppData itself or a whole application data root', () => {
    expect(Array.isArray(FAKE_HOME_EXCLUDE)).toBe(true)
    for (const x of FAKE_HOME_EXCLUDE) {
      const parts = x.split('/')
      expect(parts[0], x).toBe('AppData')
      expect(parts.length, `${x} is too wide`).toBeGreaterThanOrEqual(3)
    }
  })
  it('no comparison of the fake home in the runner excludes AppData as a whole any more', () => {
    const src = runnerSource()
    expect(src).not.toMatch(/\[\s*'AppData'\s*[\],]/)
    expect(src).not.toMatch(/exclude: \['AppData'/)
  })
})

describe('T2.34 A4: the real stage compares, after every call, the roots its baseline was taken over (protectedRoots, whatever they are)', () => {
  it('realBox takes its baseline without naming roots, and asks compareRun after every call', () => {
    const src = fnSource('async function realBox(')
    const base = /I\.takeBaseline\(\{([^}]*)\}\)/.exec(src)
    expect(base, 'realBox takes no baseline').not.toBeNull()
    // No `roots:` handed in: takeBaseline then derives them from protectedRoots (engine/integrity.ts), so the
    // comparison after each call covers every presence root that function lists, the new AppData roots included.
    expect(base[1]).not.toMatch(/\broots\s*:/)
    const after = src.slice(src.indexOf('const after = async ('))
    expect(after.indexOf('I.compareRun(runId')).toBeGreaterThan(-1)
    expect(after.indexOf('I.compareRun(runId')).toBeLessThan(after.indexOf('counts.refused++'))
  })
})

describe('T2.35 RT1: the fake stage reads the real profile by the presence roots of the real stage, AppData included', () => {
  const need = () => {
    for (const f of ['realHomeRoots', 'realHomeReading', 'realHomeLoss']) expect(typeof acceptance[f], `${f} is not exported`).toBe('function')
  }
  /** A home laid out like a profile: a project folder, a dot-folder, and application folders with two files each. */
  const homeWith = (apps) => {
    const h = join(temp('cynco-acc-rt1-'), 'home')
    for (const rel of ['Projects/a.txt', 'Projects/b.txt', '.tool/x', '.tool/y']) put8(join(h, ...rel.split('/')))
    for (const app of apps) for (const f of ['1', '2']) put8(join(h, 'AppData', 'Local', app, f))
    for (const f of ['1', '2']) { put8(join(h, 'AppData', 'Roaming', 'R', f)); put8(join(h, 'AppData', 'LocalLow', 'L', f)); put8(join(h, 'AppData', 'Local', 'Packages', 'P1', f)) }
    return h
  }
  const put8 = (p) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }
  const read = (h) => acceptance.realHomeReading(integrity, h, { cynco: join(h, '.cynco') })
  it('the roots are protectedRoots\' presence roots with no volume and no frozen root: the home\'s top level and the four application roots among them', () => {
    need()
    const h = homeWith(['A'])
    const roots = acceptance.realHomeRoots(integrity, h, { cynco: join(h, '.cynco') })
    expect(roots.frozen).toEqual([])
    const want = integrity.protectedRoots({ home: h, cynco: join(h, '.cynco') }).presence.filter(r => !r.volume).map(r => r.path)
    expect(roots.presence.map(r => r.path)).toEqual(want)
    for (const sub of [[], ['AppData', 'Local'], ['AppData', 'Roaming'], ['AppData', 'LocalLow'], ['AppData', 'Local', 'Packages']]) {
      expect(roots.presence.map(r => r.path), sub.join('/')).toContain(resolve(join(h, ...sub)))
    }
  })
  it('the 2026-11-22 shape in small: three application folders of AppData\\Local gone is a loss that names AppData', () => {
    need()
    const h = homeWith(['A', 'B', 'C', 'D'])
    const before = read(h)
    for (const app of ['A', 'B', 'C']) rmSync(join(h, 'AppData', 'Local', app), { recursive: true })
    const v = acceptance.realHomeLoss(integrity, before, read(h))
    expect(v.lost.length, JSON.stringify(v)).toBe(3)
    for (const l of v.lost) expect(l).toMatch(/AppData[\\/]Local[\\/][ABC] gone/)
  })
  it('one application folder gone is a note (the engine\'s allowance for an updater), not a loss; and it is named', () => {
    need()
    const h = homeWith(['A', 'B'])
    const before = read(h)
    rmSync(join(h, 'AppData', 'Local', 'A'), { recursive: true })
    const v = acceptance.realHomeLoss(integrity, before, read(h))
    expect(v.lost).toEqual([])
    expect(v.notes.join('\n')).toMatch(/AppData[\\/]Local.*A/)
  })
  it('a non-dot project folder of the home gone is a loss (no allowance for the owner\'s own folders)', () => {
    need()
    const h = homeWith(['A'])
    const before = read(h)
    rmSync(join(h, 'Projects'), { recursive: true })
    expect(acceptance.realHomeLoss(integrity, before, read(h)).lost.join('\n')).toMatch(/Projects gone/)
  })
  it('runFakeStage reads the real profile this way before the fake profile is built and again after the disarm, and a loss fails the stage', () => {
    const src = fnSource('export async function runFakeStage(')
    const first = src.indexOf('realHomeReading(')
    expect(first, 'runFakeStage never reads the real profile by the presence roots').toBeGreaterThan(-1)
    expect(first).toBeLessThan(src.indexOf('buildFakeProfile(root, nonce)'))
    const second = src.indexOf('realHomeReading(', first + 1)
    expect(second).toBeGreaterThan(src.indexOf('disarmMission(fake, nonce)'))
    expect(src).toMatch(/realHomeLoss\(/)
    expect(src).toMatch(/report\.realProfileLoss = /)
  })
})

describe('T2.36 RS-5: the real-profile stage seeds and judges the dot-folder decoys only, as before wave 8', () => {
  it('realBox names the dot set at every seed and every reading of the decoys', () => {
    const src = fnSource('async function realBox(')
    expect(src).not.toMatch(/seedDecoys\(ctx\)/)
    expect(src).not.toMatch(/decoysState\(ctx\)/)
    expect((src.match(/seedDecoys\(ctx, 'dot'\)/g) ?? []).length).toBe(3)
    expect((src.match(/decoysState\(ctx, 'dot'\)/g) ?? []).length).toBe(1)
  })
})

describe('T2.37 wave 11: the box rehearsal, and the defects the audit of realBox found', () => {
  const W = acceptance
  const need = (...names) => { for (const n of names) expect(typeof W[n], `${n} is not exported`).not.toBe('undefined') }

  describe('rehearsalRefusal: the box runs against the fake home only (property 1 of the brief)', () => {
    const root = temp('cynco-acc-w11-')
    writeFileSync(join(root, '.cynco-acceptance-root'), 'beefcafe')
    const inside = (rel) => join(root, ...rel.split('/'))
    const v = { home: inside('profile/Users/tester'), temp: inside('profile/Users/tester/AppData/Local/Temp'), state: inside('profile/Users/tester/.cynco'),
      guard: inside('guard'), audit: inside('audit'), models: inside('models'), sandboxRoot: inside('sandbox-root') }
    // Changed on purpose in wave 11b (G8): rehearsalRefusal also needs the machine's own folders, which must lie outside
    // the root; the real ones (machineFolders) are, since this root is a temp folder below the real home.
    // Changed on purpose in wave 11c (H4): machineFolders also asks this process's own models folder (P.modelsDir).
    const machine = (() => { const P = { guardDir: () => 'C:/cynco-guard', auditDir: () => 'C:/cynco-audit', sandboxRoot: () => 'C:/cynco-sandbox', modelsDir: () => 'C:/cynco-models' }; return W.machineFolders ? W.machineFolders(P, homedir()) : undefined })()
    const args = (o = {}) => ({ root, nonce: 'beefcafe', env: {}, readSentinel: (r) => readFileSync(join(r, '.cynco-acceptance-root'), 'utf8'), v, machine, ...o })
    it('every folder inside the test root, the sentinel holding the nonce, the variable unset: null', () => {
      need('rehearsalRefusal')
      expect(W.rehearsalRefusal(args())).toBeNull()
    })
    it('the real-profile variable set: refused, whatever else is right', () => {
      expect(W.rehearsalRefusal(args({ env: { [REAL_PROFILE_VAR]: '1' } }))).toBe(`${REAL_PROFILE_VAR} is set`)
    })
    it('a wrong nonce, or no sentinel: refused', () => {
      expect(W.rehearsalRefusal(args({ nonce: 'other' }))).toMatch(/does not carry this run's sentinel/)
      expect(W.rehearsalRefusal(args({ readSentinel: () => null }))).toMatch(/does not carry this run's sentinel/)
      expect(W.rehearsalRefusal(args({ readSentinel: () => { throw new Error('EACCES') } }))).toMatch(/does not carry this run's sentinel/)
    })
    it('each folder outside the root, the real home among them: refused by name', () => {
      const elsewhere = temp('cynco-acc-w11-out-')
      for (const k of Object.keys(v)) {
        expect(W.rehearsalRefusal(args({ v: { ...v, [k]: elsewhere } })), k).toBe(`the ${k} folder (${elsewhere}) is not inside the test root ${root} by real path`)
      }
      expect(W.rehearsalRefusal(args({ v: { ...v, home: 'C:\\Users\\owner' } }))).toMatch(/^the home folder \(C:\\Users\\owner\) is not inside the test root/)
      expect(W.rehearsalRefusal(args({ v: { ...v, guard: '' } }))).toBe('the guard folder is not known')
    })
    it('a guard folder reached through a link inside the root that leads out: refused (by real path)', () => {
      const out = temp('cynco-acc-w11-target-')
      const link = join(root, 'guard-link')
      symlinkSync(out, link, WIN ? 'junction' : 'dir')
      linksToRemove.push(link)
      expect(W.rehearsalRefusal(args({ v: { ...v, guard: link } }))).toMatch(/^the guard folder .*guard-link\) is not inside the test root .* by real path$/)
      expect(W.rehearsalRefusal(args({ v: { ...v, guard: join(link, 'below') } }))).toMatch(/^the guard folder /)
    })
    it('a relative root: refused', () => expect(W.rehearsalRefusal(args({ root: 'rel' }))).toBe('the test root rel is not an absolute path'))
  })

  describe('finding 1: the audit preflight reads the probe\'s null as the written record', () => {
    it('a handle whose probe wrote its record: null; a reason: the reason; no handle: refused; anything else: refused', () => {
      need('auditPreflight')
      const asked = []
      const h = (answer) => ({ probe: (by) => { asked.push(by); return answer } })
      expect(W.auditPreflight(h(null))).toBeNull()
      expect(asked).toEqual(['preflight'])
      expect(W.auditPreflight(h('audit-dir-unwritable: x'))).toBe('audit-dir-unwritable: x')
      expect(W.auditPreflight(null)).toBe('no audit handle for this run')
      expect(W.auditPreflight(undefined)).toBe('no audit handle for this run')
      expect(W.auditPreflight(h(undefined))).toBe('the audit probe gave no answer (undefined)')
      expect(W.auditPreflight(h(''))).toBe('the audit probe gave no answer ()')
    })
    it('realBox asks it, and no longer turns the probe\'s null into a refusal with ??', () => {
      const src = fnSource('async function realBox(')
      expect(src).toContain('const au = auditPreflight(A.toolAudit())')
      expect(src).toContain("if (au !== null) { say(layerRefusalLine('audit', au)); code = 2; return { code } }")
      expect(src).not.toMatch(/probe\('preflight'\)\s*\?\?/)
    })
  })

  describe('finding 2: the end-of-box audit reads every file of the run\'s days and counts this run only', () => {
    const procOf = (o = {}) => ({ proc: 'p-1', records: 8, firstSeq: 1, gaps: [], gapCount: 0, headMissing: false, runs: ['run-a'], openStarts: [], ...o })
    it('auditFilesFor: the day files from the first day to today, roll-overs included, nothing else', () => {
      need('auditFilesFor')
      const re = /^\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/
      const names = ['2026-11-23.jsonl', '2026-11-24.jsonl', '2026-11-24.1.jsonl', '2026-11-25.jsonl', '2026-11-22.jsonl', '.cynco-audit', 'notes.txt', '2026-11-24.jsonl.tmp']
      expect(W.auditFilesFor(names, { from: '2026-11-23', to: '2026-11-24', re })).toEqual(['2026-11-23.jsonl', '2026-11-24.1.jsonl', '2026-11-24.jsonl'])
      expect(W.auditFilesFor(names, { from: '2026-11-24', to: '2026-11-24', re })).toEqual(['2026-11-24.1.jsonl', '2026-11-24.jsonl'])
      expect(W.auditFilesFor([], { from: '2026-11-24', to: '2026-11-24', re })).toEqual([])
    })
    it('auditVerdict: the table', () => {
      need('auditVerdict')
      const files = ['C:\\a\\2026-11-24.jsonl']
      const ok = W.auditVerdict({ v: { procs: [procOf()], unparsable: 0 }, runId: 'run-a', files })
      expect(ok).toMatchObject({ ok: true, why: null })
      expect(ok.line).toBe('0 gap(s), 0 start(s) without an end, 0 unparsable line(s); files read: 2026-11-24.jsonl; 1 process(es) wrote 8 record(s) for run-a')
      // A gap or an open start another process left that day is not this run's (it failed the box before).
      expect(W.auditVerdict({ v: { procs: [procOf(), procOf({ proc: 'p-2', runs: ['other'], gapCount: 3, openStarts: [{ seq: 4 }] })], unparsable: 0 }, runId: 'run-a', files }).ok).toBe(true)
      const rows = [
        [{ procs: [procOf({ gapCount: 2 })], unparsable: 0 }, files, 'the audit has a gap or an open start'],
        [{ procs: [procOf({ openStarts: [{ seq: 3 }] })], unparsable: 0 }, files, 'the audit has a gap or an open start'],
        [{ procs: [procOf({ headMissing: true })], unparsable: 0 }, files, 'the audit is missing the head of a process of this run'],
        [{ procs: [procOf({ runs: ['other'] })], unparsable: 0 }, files, 'no audit record of run-a was found'],
        [{ procs: [procOf()], unparsable: 1 }, files, 'the audit has 1 unparsable line(s) or unreadable file(s)'],
        [{ procs: [], unparsable: 0 }, [], 'no audit file of the days of this run was found'],
      ]
      for (const [v, f, why] of rows) {
        const r = W.auditVerdict({ v, runId: 'run-a', files: f })
        expect(r.ok, why).toBe(false)
        expect(r.why).toBe(why)
      }
    })
    it('the engine\'s verifyAuditFiles on a day file that is not there counts it unparsable, which is no longer a pass', async () => {
      const { verifyAuditFiles } = await import('../../engine/audit/toolAudit.js')
      const missing = join(temp('cynco-acc-w11-audit-'), '2026-11-24.jsonl')
      const v = verifyAuditFiles([missing])
      expect(v).toEqual({ procs: [], unparsable: 1 })
      expect(W.auditVerdict({ v, runId: 'run-a', files: [missing] }).ok).toBe(false)
    })
    it('realBox lists the audit folder, takes the first day before the baseline, and fails on the verdict', () => {
      const src = fnSource('async function realBox(')
      expect(src.indexOf('const day0 = localDay()')).toBeGreaterThan(-1)
      expect(src.indexOf('const day0 = localDay()')).toBeLessThan(src.indexOf('I.takeBaseline('))
      expect(src).toContain('auditFilesFor(names, { from: day0, to: localDay(), re: A.AUDIT_FILE_RE })')
      expect(src).toContain('const av = auditVerdict({ v: A.verifyAuditFiles(files), runId, files })')
      // Changed on purpose in wave 11b (G3): the end-of-box decision moved into settleVerdict (table tested in T2.38),
      // which realBox hands the audit verdict.
      expect(src).toContain('const end = settleVerdict({ settle, lost, deepFail, audit: av, where })')
      expect(src).not.toContain('`${localDay()}.jsonl`')
    })
  })

  describe('finding 3: a census loss or a deep-count fall counts only when a second reading shows it', () => {
    it('confirmedLoss keeps, by name, what both readings show, in the second reading\'s words', () => {
      need('confirmedLoss', 'censusLoss')
      const c0 = ['.a\tdir\t4', '.b\tfile\t0', '.c\tdir\t10']
      const first = W.censusLoss(c0, ['.a\tdir\t4', '.c\tdir\t4'])
      expect(first).toEqual(['.b is gone', '.c fell from 10 to 4 entries'])
      // The dot-file came back (delete-then-rename), the folder fell further: only the folder counts.
      expect(W.confirmedLoss(first, W.censusLoss(c0, ['.a\tdir\t4', '.b\tfile\t0', '.c\tdir\t2']))).toEqual(['.c fell from 10 to 2 entries'])
      expect(W.confirmedLoss(first, W.censusLoss(c0, c0))).toEqual([])
      expect(W.confirmedLoss(first, first)).toEqual(first)
      expect(W.confirmedLoss([], ['.a is gone'])).toEqual([])
      // An unlistable folder reads -1 children.
      expect(W.confirmedLoss(['.c fell from 10 to -1 entries'], ['.c fell from 10 to -1 entries'])).toEqual(['.c fell from 10 to -1 entries'])
    })
    it('deepFall: every fall named, and a fall of files beyond 2 % fails; an entry gone is 0', () => {
      need('deepFall')
      const d0 = [{ name: '.big', files: 1000, bytes: 5000 }, { name: '.one', files: 1, bytes: 10 }, { name: '.same', files: 3, bytes: 3 }]
      const inside = W.deepFall(d0, [{ name: '.big', files: 990, bytes: 4900 }, { name: '.one', files: 1, bytes: 10 }, { name: '.same', files: 3, bytes: 3 }])
      expect(inside).toEqual({ fell: ['.big (files 1000 -> 990, bytes 5000 -> 4900)'], lines: ['deep count: .big: files 1000 -> 990, bytes 5000 -> 4900'], fail: false })
      const gone = W.deepFall(d0, [{ name: '.big', files: 1000, bytes: 5000 }, { name: '.same', files: 3, bytes: 3 }])
      expect(gone.fail).toBe(true)
      expect(gone.fell).toEqual(['.one (files 1 -> 0, bytes 10 -> 0)'])
      expect(W.deepFall(d0, d0)).toEqual({ fell: [], lines: [], fail: false })
    })
    it('realBox confirms both before they count: the latch after a call only on a confirmed loss, the deep count again before it fails', () => {
      const src = fnSource('async function realBox(')
      const confirm = src.slice(src.indexOf('const censusNow = async () => {'))
      expect(confirm).toMatch(/await new Promise\(done => setTimeout\(done, CONFIRM_MS\)\)\n\s*const both = confirmedLoss\(first, censusLoss\(c0, censusOf\(home\)\)\)/)
      const after = src.slice(src.indexOf('const after = async ('))
      expect(after.indexOf('const lost = await censusNow()')).toBeGreaterThan(-1)
      expect(after.indexOf('const lost = await censusNow()')).toBeLessThan(after.indexOf("reason: 'presence-lost'"))
      expect(after).not.toMatch(/const lost = censusLoss\(/)
      const end = src.slice(src.indexOf('// G7: the end.'))
      expect(end).toContain('const lost = await censusNow()')
      const again = end.slice(end.indexOf('if (deep.fail) {'))
      expect(end.indexOf('if (deep.fail) {')).toBeGreaterThan(-1)
      expect(again).toMatch(/^if \(deep\.fail\) \{\n[^\n]*\n\s*await new Promise\(done => setTimeout\(done, CONFIRM_MS\)\)\n\s*deep = deepFall\(d0, deepCountOf\(home\)\)/)
      expect(again.indexOf('const deepFail = deep.fail')).toBeGreaterThan(again.indexOf('deep = deepFall(d0, deepCountOf(home))'))
    })
  })

  describe('finding 5: an attack refused by the path check whose audit counts are off is never called one that ran', () => {
    it('afterVerdict: the table', () => {
      need('afterVerdict')
      const good = { refused: 1, start: 0, end: 0, layer: 'protected path' }
      const ok = W.afterVerdict({ isError: true, layer: 'protected path', audit: good, decoys: 'intact' })
      expect(ok).toEqual({ ok: true, why: null, line: 'refused before it ran by the protected path layer; audit {"refused":1,"start":0,"end":0,"layer":"protected path"}' })
      const twice = W.afterVerdict({ isError: true, layer: 'protected path', audit: { ...good, refused: 2 }, decoys: 'intact' })
      expect(twice.ok).toBe(false)
      expect(twice.why).toBe('was refused by the path check, but its audit record does not match (audit {"refused":2,"start":0,"end":0,"layer":"protected path"}; decoys intact)')
      expect(twice.why).not.toMatch(/not refused/)
      const ran = W.afterVerdict({ isError: true, layer: 'protected path', audit: good, decoys: 'gone' })
      expect(ran.why).toMatch(/^was refused by the path check, but the decoys are gone: the command ran before the refusal/)
      const notRefused = W.afterVerdict({ isError: false, layer: null, audit: { refused: 0, start: 1, end: 1, layer: null }, decoys: 'intact' })
      expect(notRefused.why).toBe('was not refused before it ran (isError false, layer none, audit {"refused":0,"start":1,"end":1,"layer":null}, decoys intact)')
      // Changed on purpose in wave 11b (G4): the audit records the path check's refusal here, so the words say that, and
      // that the answer names another layer; "not refused" is kept for an audit that records no refusal (T2.38).
      expect(W.afterVerdict({ isError: true, layer: 'containment', audit: good, decoys: 'intact' }).why).toMatch(/^was refused \(the audit records the protected path layer\), but its answer does not name the layer \(isError true, layer containment/)
    })
    it('realBox prints the verdict\'s words in its ABORT line and the counts of every refused call', () => {
      const src = fnSource('async function realBox(')
      expect(src).toContain('const verdict = afterVerdict({ isError: r.isError, layer, audit, decoys })')
      expect(src).toContain('say(`${TAG} ABORT: attack ${id} (${title}, ${v.label}) ${verdict.why}: ${r.output.slice(0, 200)}.')
      // Changed on purpose in wave 11d (K3, review F4): the whole statement, which now ends by naming the mission folder a
      // call that was not refused may have planted code in (a hook), so that nobody runs git or pytest there.
      expect(src).toMatch(/^ {8}else say\(`\$\{TAG\} ABORT: attack \$\{id\} \(\$\{title\}, \$\{v\.label\}\) \$\{verdict\.why\}: \$\{r\.output\.slice\(0, 200\)\}\. Manifest after it: \$\{cmp\.changed \? 'CHANGED' : 'unchanged'\}\. The remaining, more destructive attacks were not run\. Do not run git or pytest in \$\{mission\}: it may hold what the call planted\.`\)$/m)
      expect(src).toContain('say(`${TAG} ${id} ${v.label}: ${verdict.line}`)')
      expect(src).not.toContain('was not refused before it ran:')
    })
  })

  it('finding 4: realMain writes a throw to the evidence and closes the file whatever happened', () => {
    const src = fnSource('async function realMain(')
    expect(src).toMatch(/try \{\n\s*const r = await runRealStage\(/)
    expect(src).toMatch(/\} catch \(e\) \{\n\s*say\(`\$\{TAG\} FAIL: the real-profile stage threw: \$\{e\?\.stack \?\? e\}`\)\n\s*return 1\n\s*\} finally \{\n\s*if \(evidenceFd !== null\) \{\n\s*closeSync\(evidenceFd\)/)
  })

  describe('the rehearsal\'s result', () => {
    it('honestClass: only the two pytest lines of the rehearsal are accepted, and never on the real profile', () => {
      need('honestClass')
      const b = { key: 'b', ok: null, line: pytestCause({ refused: null, isError: true, output: "ModuleNotFoundError: No module named 'pytest'", file: '', inRoot: false }).line }
      const c = { key: 'c', ok: null, line: '(c) not proven: no module was imported from the user site C:\\r\\AppData\\Roaming\\Python\\Python314\\site-packages (pytest: not importable)' }
      expect(W.honestClass(b, true)).toBe('pytest-not-in-fake-site')
      expect(W.honestClass(c, true)).toBe('pytest-not-in-fake-site')
      expect(W.honestClass(b, false)).toBe('honest-b')
      expect(W.honestClass(c, false)).toBe('honest-c')
      expect(W.honestClass({ ...c, line: '(c) not proven: no module was imported from the user site C:\\s (pytest: C:\\py\\pytest\\__init__.py)' }, true)).toBe('honest-c')
      expect(W.honestClass({ key: 'b', line: '(b) not proven: the call that asks for pytest failed: x' }, true)).toBe('honest-b')
    })
    it('realResult: the rehearsal\'s list accepts the fake site\'s pytest, its PASS line names the place and four probes; the defaults are the real stage\'s', () => {
      need('REHEARSAL_ACCEPTED_NOT_PROVEN')
      const items = [{ what: 'honest work (b) not proven: no module named pytest', cls: 'pytest-not-in-fake-site' }]
      const reh = realResult({ items, refused: 12, calls: 14, fell: [], accepted: W.REHEARSAL_ACCEPTED_NOT_PROVEN, where: 'box rehearsal, fake home', probes: 4 })
      expect(reh.pass).toBe(false)
      const ok = realResult({ items: [...items, { what: 'twin', cls: 'git-bash-did-not-start' }, { what: 'twin 2', cls: 'git-bash-did-not-start' }], refused: 12, calls: 14, accepted: W.REHEARSAL_ACCEPTED_NOT_PROVEN, where: 'box rehearsal, fake home', probes: 4 })
      expect(ok.pass).toBe(true)
      expect(ok.lines[0]).toBe('[acceptance] RESULT: PASS (box rehearsal, fake home): 4 create probes denied, 12 calls refused before running and 2 accepted twins that did not resolve, of 14 calls taken up, 3 not proven (each in the accepted list), manifest unchanged after each, no loss in the home census or the deep count.')
      expect(ok.lines[1]).toMatch(/^\[acceptance\] not proven: honest work \(b\).*\[accepted, pytest-not-in-fake-site: pytest is installed only in the real user site/)
      // The real stage does not accept it: the same item with the defaults is INCOMPLETE, in the real stage's words.
      const real = realResult({ items, refused: 12, calls: 12 })
      expect(real.pass).toBe(false)
      expect(real.lines[0]).toMatch(/^\[acceptance\] RESULT: INCOMPLETE \(real profile\): 1 not-proven item outside the accepted list/)
      expect(realResult({ items: [], refused: 3, calls: 3 }).lines[0]).toBe('[acceptance] RESULT: PASS (real profile): 5 create probes denied, 3 calls refused before running and 0 accepted twins that did not resolve, of 3 calls taken up, 0 not proven (each in the accepted list), manifest unchanged after each, no loss in the home census or the deep count.')
      expect(Object.keys(W.REHEARSAL_ACCEPTED_NOT_PROVEN).sort()).toEqual(['deep-count-unreadable', 'git-bash-did-not-start', 'pytest-not-in-fake-site'])
      expect(W.REHEARSAL_ACCEPTED_NOT_PROVEN['pytest-not-in-fake-site']).toBe(ACCEPTED_NOT_PROVEN.find(x => x.reason === 'pytest-not-in-fake-site').words)
    })
    it('rehearsalOutcome and boxVerdictLine: an ABORT, a refusal, a throw, a changed fake home or a latch is FAILED; INCOMPLETE is not proven', () => {
      need('rehearsalOutcome', 'boxVerdictLine')
      const lines = ['[acceptance] rehearsal: x', '[acceptance] preflight: y', '[acceptance] RESULT: PASS (box rehearsal, fake home): z', '[acceptance] not proven: w', '[acceptance] the settling compare for r: unchanged']
      expect(W.boxVerdictLine(lines)).toBe('RESULT: PASS (box rehearsal, fake home): z')
      expect(W.boxVerdictLine(['[acceptance] a', '[acceptance] ABORT: attack q was refused by the path check, but x', '[acceptance] RESULT: FAIL (x)'])).toBe('ABORT: attack q was refused by the path check, but x')
      expect(W.boxVerdictLine(['[acceptance] a'])).toBeNull()
      const verdict = 'RESULT: PASS (box rehearsal, fake home): z'
      expect(W.rehearsalOutcome({ code: 0, result: { pass: true }, verdict })).toEqual({ outcome: 'passed', detail: verdict })
      expect(W.rehearsalOutcome({ code: 1, result: { pass: false }, verdict: 'RESULT: INCOMPLETE (box rehearsal, fake home): q' }).outcome).toBe('not proven')
      expect(W.rehearsalOutcome({ code: 1, verdict: 'ABORT: attack q was not refused before it ran' })).toEqual({ outcome: 'FAILED', detail: 'ABORT: attack q was not refused before it ran' })
      expect(W.rehearsalOutcome({ code: 2, verdict: 'REFUSED: audit: x — nothing was run' }).outcome).toBe('FAILED')
      expect(W.rehearsalOutcome({ code: null, threw: 'TypeError: x' })).toEqual({ outcome: 'FAILED', detail: 'the box threw: TypeError: x' })
      expect(W.rehearsalOutcome({ code: 0, result: { pass: true }, verdict, homeDiff: ['gone .ssh/id_fake'] })).toEqual({ outcome: 'FAILED', detail: `the rehearsal changed the fake home: gone .ssh/id_fake (${verdict})` })
      expect(W.rehearsalOutcome({ code: 0, result: { pass: true }, verdict, latch: 'the integrity latch is set' }).outcome).toBe('FAILED')
      expect(W.rehearsalOutcome({ code: 1, verdict: null }).detail).toBe('the box printed no deciding line')
    })
    it('rehearsalCoverage: on Windows, a run 9 that reported has exactly one box entry; off Windows nothing is asked', () => {
      need('rehearsalCoverage')
      // Changed on purpose in wave 11b (G2): a passed entry carries the box's own PASS line as its detail, as rehearseBox
      // writes it; one without it is a gap (T2.38).
      const box = { run: 9, id: 'box', variant: 'realBox', form: 'rehearsal', outcome: 'passed', detail: 'RESULT: PASS (box rehearsal, fake home): z' }
      const rep = (o) => ({ platform: 'win32', innerRuns: [{ run: 9 }], entries: [box], ...o })
      expect(W.rehearsalCoverage(rep())).toEqual([])
      expect(W.rehearsalCoverage(rep({ entries: [] }))).toEqual(['run 9 has no entry for box realBox rehearsal'])
      expect(W.rehearsalCoverage(rep({ entries: [box, box] }))).toEqual(['run 9 has 2 entries for box realBox rehearsal'])
      expect(W.rehearsalCoverage(rep({ innerRuns: [], entries: [] }))).toEqual([])
      expect(W.rehearsalCoverage(rep({ platform: 'linux', entries: [] }))).toEqual([])
    })
    it('finishFake: a rehearsal that FAILED fails the stage, one that is not proven keeps it INCOMPLETE, one missing is a coverage FAIL', () => {
      const E = (run, id, variant, form, outcome, detail = null) => ({ run, phase: 'x', id, variant, form, outcome, detail, decoys: null, audit: null, targets: [] })
      const rep = (boxEntry) => ({ stage: 'fake', platform: 'win32', root: null, refused: null, liveFire: false, lowIntegrity: 'low', links: [], firstFailure: null, tools: null,
        realProfileLoss: false, realProfileUnmeasured: [], innerRuns: [1, 2, 3, 4, 5, 9].map(run => ({ run })), entries: [E(3, 'x', 'y', 'literal', 'refused'), ...(boxEntry ? [boxEntry] : [])] })
      const result = (r) => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
        try { finishFake(r); return spy.mock.calls.map(c => String(c[0])).find(l => l.includes('RESULT:')) } finally { spy.mockRestore() }
      }
      const passed = rep(E(9, 'box', 'realBox', 'rehearsal', 'passed', 'RESULT: PASS (box rehearsal, fake home): z'))
      expect(result(passed)).toMatch(/RESULT: PASS \(fake home\)/)
      const failed = rep(E(9, 'box', 'realBox', 'rehearsal', 'FAILED', 'ABORT: attack q was not refused before it ran'))
      expect(result(failed)).toMatch(/RESULT: FAIL \(fake home\): box realBox rehearsal: ABORT: attack q/)
      expect(failed.pass).toBe(false)
      const np = rep(E(9, 'box', 'realBox', 'rehearsal', 'not proven', 'RESULT: INCOMPLETE (box rehearsal, fake home): q'))
      expect(result(np)).toMatch(/RESULT: INCOMPLETE \(fake home\): 1 not-proven entry outside the accepted table, the first: run 9 box realBox rehearsal: not proven/)
      expect(np.pass).toBe(false)
      const none = rep(null)
      expect(result(none)).toMatch(/RESULT: FAIL \(fake home\): coverage: run 9 has no entry for box realBox rehearsal/)
    })
  })

  describe('the rehearsal reaches the real profile by no path (property 2 of the brief: the real stage unchanged)', () => {
    it('only rehearseBox hands realBox a rehearsal; runRealStage hands it what realMain gave, which names none', () => {
      const s = runnerSource()
      const calls = s.match(/\brealBox\([^)]*\)/g) ?? []
      expect(calls.filter(c => !c.startsWith('realBox(C, I, a, fakeReport')).sort()).toEqual(['realBox(C, I, a, fake, unprotected)', 'realBox(C, I, { rehearsal }, null, [])'].sort())
      expect(fnSource('export async function runRealStage(')).not.toMatch(/rehearsal/i)
      expect(fnSource('async function realMain(')).toContain("runRealStage({ argv, evidence: args.values['--evidence'], nas: args.values['--nas'] })")
      // Changed on purpose in wave 11c (H4): the rehearsal also carries the machine's own folders the fake stage handed.
      expect(fnSource('async function rehearseBox(')).toContain('const rehearsal = { root, nonce, lines: [], box: null, machine }')
      // No flag or variable turns a rehearsal on: the argument parser takes no such word, and only --inner box --phase rehearsal reaches it.
      expect(fnSource('function parseArgs(')).not.toMatch(/rehears/i)
      // Changed on purpose in wave 11c (H4): rehearseBox is handed the machine's folders from --machine.
      expect(fnSource('async function innerMain(')).toContain("if (spec.mode === 'box') await rehearseBox(spec, root, nonce, report, machineFoldersFrom(a.values['--machine']))")
    })
    it('realBox refuses before anything is made, pages nobody, and skips the hive and the machine with a printed line, in a rehearsal only', () => {
      const src = fnSource('async function realBox(')
      // Changed on purpose in wave 11b (G8): the call hands the machine's own folders too.
      const refusal = src.indexOf('const why = rehearsalRefusal({ root: rehearsal.root, nonce: rehearsal.nonce, env: process.env, readSentinel: readSentinelOf, v: boxFolders(P0), machine })')
      expect(refusal).toBeGreaterThan(-1)
      for (const later of ['mkdtempSync(', 'I.takeBaseline(', 'C.establishContainment(', 'viaToolExec(']) expect(refusal, later).toBeLessThan(src.indexOf(later))
      expect(src).toContain("if (why !== null) { say(`${TAG} REFUSED (rehearsal): ${why} — the box was not run`); return { code: 2 } }")
      expect(src).toContain('const page = rehearsal ? async () => false : await (async () => {')
      expect(src).toMatch(/if \(rehearsal\) \{\n[^\n]*\n\s*say\(`\$\{TAG\} the registry probe: skipped in the rehearsal: HKCU is the real user's hive, which no environment repoints/)
      expect(src).toMatch(/\} else \{\n\s*const key = `HKCU\\\\Software\\\\cynco-containment-probe-\$\{nonce\}`/)
      expect(src).toContain("if (rehearsal) { say(`${TAG} reachable from a contained child: ${name}: skipped in the rehearsal: it asks the machine, not the fake home, and the real stage asks it`); continue }")
      expect(src).toContain("if (rehearsal) say(`${TAG} the NOT PROVEN block: skipped in the rehearsal: it speaks of the real profile`)")
      // The real stage's lines are unchanged: the share line is asked before the skip, so it still says "not asked".
      const g9 = src.slice(src.indexOf('// G9: reachability'))
      expect(g9.indexOf('not asked')).toBeLessThan(g9.indexOf('skipped in the rehearsal'))
    })
  })
})

describe('T2.38 wave 11b: what the review of the rehearsal left', () => {
  const W = acceptance
  const need = (...names) => { for (const n of names) expect(typeof W[n], `${n} is not exported`).not.toBe('undefined') }
  const good = { refused: 1, start: 0, end: 0, layer: 'protected path' }
  const refusedV = () => W.afterVerdict({ isError: true, layer: 'protected path', audit: good, decoys: 'intact' })
  const ranV = () => W.afterVerdict({ isError: false, layer: null, audit: { refused: 0, start: 1, end: 1, layer: null }, decoys: 'intact' })
  const CONTROL_ABORT = 'ABORT: the control call, which the path check allows, was read as refused: this box cannot tell a refused call from one that ran. No attack was run.'

  describe('G1 the control: a call the path check allows, read by the attacks\' own path, must read "not refused"', () => {
    it('afterReading: the table, the attacks\' rows and the control\'s', () => {
      need('afterReading', 'CONTROL_READ_AS_REFUSED')
      expect(W.CONTROL_READ_AS_REFUSED).toBe(CONTROL_ABORT)
      const rows = [
        // [what, input, act, by]
        ['an attack refused, the census not read yet', { verdict: refusedV(), changed: false, lost: null }, 'census'],
        ['an attack refused, all clear', { verdict: refusedV(), changed: false, lost: [] }, 'go'],
        ['an attack refused, the compare changed', { verdict: refusedV(), changed: true, lost: [] }, 'latch', 'compare'],
        ['an attack refused, a confirmed census loss', { verdict: refusedV(), changed: false, lost: ['.a is gone'] }, 'latch', 'census'],
        ['an attack refused, both', { verdict: refusedV(), changed: true, lost: ['.a is gone'] }, 'latch', 'compare'],
        ['an attack that ran', { verdict: ranV(), changed: false, lost: null }, 'abort'],
        ['an attack that ran, the compare changed', { verdict: ranV(), changed: true, lost: ['.a is gone'] }, 'abort'],
        ['an attack with no verdict', { verdict: undefined, changed: false, lost: [] }, 'abort'],
        ['the control ran, the census not read yet', { control: true, verdict: ranV(), made: true, changed: false, lost: null }, 'census'],
        ['the control ran, all clear', { control: true, verdict: ranV(), made: true, changed: false, lost: [] }, 'go'],
        ['the control ran, the compare changed', { control: true, verdict: ranV(), made: true, changed: true, lost: [] }, 'latch', 'compare'],
        ['the control ran, a confirmed census loss', { control: true, verdict: ranV(), made: true, changed: false, lost: ['.a is gone'] }, 'latch', 'census'],
        ['the control read as refused', { control: true, verdict: refusedV(), made: true, changed: false, lost: [] }, 'abort'],
        ['the control with no verdict', { control: true, verdict: undefined, made: true, changed: false, lost: [] }, 'abort'],
        ['the control made no file', { control: true, verdict: ranV(), made: false, changed: false, lost: [] }, 'abort'],
      ]
      for (const [what, input, act, by] of rows) {
        const r = W.afterReading(input)
        expect(r.act, what).toBe(act)
        if (by) expect(r.by, what).toBe(by)
      }
      // The attack's ABORT line is realBox's own (pinned in T2.37); the control's are the reading's.
      expect(W.afterReading({ verdict: ranV(), changed: false, lost: null }).line).toBeNull()
      expect(W.afterReading({ control: true, verdict: refusedV(), made: true, changed: false, lost: [] }).line).toBe(CONTROL_ABORT)
      expect(W.afterReading({ control: true, verdict: undefined, made: true, changed: false, lost: [] }).line).toBe(CONTROL_ABORT)
      expect(W.afterReading({ control: true, verdict: ranV(), made: false, changed: false, lost: [] }).line)
        .toBe(`ABORT: the control call, which the path check allows, made no file (${ranV().why}): this box cannot show that a call that ran is read as one that ran. No attack was run.`)
      // A compare that gave no boolean, or a census that is not a list, is never "clear".
      expect(W.afterReading({ verdict: refusedV(), changed: undefined, lost: [] }).act).toBe('latch')
      expect(W.afterReading({ verdict: refusedV(), changed: false, lost: 'x' }).act).toBe('latch')
    })
    it('realBox hands the control to the same fire / after path before the first attack, never counts it, and stops on its reading', () => {
      const src = fnSource('async function realBox(')
      const loop = src.indexOf('for (const id of ATTACK_ORDER) {')
      const control = src.indexOf('const controlOk = await fire({ id: \'control\', title: \'the control\' }, controlV, { file: controlFile })')
      expect(control, 'the control call').toBeGreaterThan(-1)
      expect(control).toBeLessThan(loop)
      expect(src).toContain('const controlFile = join(mission, `cynco-acceptance-control-${nonce}.txt`)')
      expect(src).toContain("const controlV = { label: 'the control', call: { tool: 'Write', input: { file_path: controlFile, content: 'acceptance control\\n' } } }")
      expect(src).toContain('if (!controlOk) return { code: 1 }')
      // One fire, one after: the attacks' loop calls the same function.
      expect((src.match(/const fire = async \(/g) ?? []).length).toBe(1)
      expect((src.match(/const after = async \(/g) ?? []).length).toBe(1)
      expect(src).toContain('fire: () => fire(at, v),')
      expect(src).toContain('ok = await fire(at, v)')
      // The reading decides, in after(), twice: before the census and after it.
      const after = src.slice(src.indexOf('const after = async ('), src.indexOf('const fire = async ('))
      expect((after.match(/afterReading\(\{ control: control !== null, verdict, made, changed: cmp\.changed, lost/g) ?? []).length).toBe(2)
      // counts.attacks is taken up in the loop only; the control adds to no count.
      expect((src.match(/counts\.attacks\+\+/g) ?? []).length).toBe(1)
      expect(src.indexOf('counts.attacks++')).toBeGreaterThan(loop)
      expect(after).toContain('if (!control) { counts.calls++;')
      expect(after).toContain('if (!control) { say(`${TAG} ${id} ${v.label}: ${verdict.line}`); counts.refused++ }')
      // The control's file is removed by its literal path, never a pattern.
      expect(after).toContain('const gone = removeOne(control.file)')
    })
  })

  describe('G2 rehearsalCoverage: a passed rehearsal carries the box\'s own deciding line', () => {
    it('a passed entry whose detail is a REFUSED, an ABORT or any line but the box\'s PASS line is a gap', () => {
      need('rehearsalCoverage')
      const box = (o) => ({ run: 9, id: 'box', variant: 'realBox', form: 'rehearsal', outcome: 'passed', detail: 'RESULT: PASS (box rehearsal, fake home): z', ...o })
      const rep = (e) => ({ platform: 'win32', innerRuns: [{ run: 9 }], entries: [e] })
      expect(W.rehearsalCoverage(rep(box()))).toEqual([])
      for (const detail of [`REFUSED (rehearsal): ${REAL_PROFILE_VAR} is set`,'ABORT: attack q was not refused before it ran', 'RESULT: PASS (real profile): z', 'RESULT: INCOMPLETE (box rehearsal, fake home): q', '', null]) {
        const gaps = W.rehearsalCoverage(rep(box({ detail })))
        expect(gaps, String(detail)).toHaveLength(1)
        expect(gaps[0], String(detail)).toMatch(/^run 9's box realBox rehearsal reads passed, but its detail is not the box's own PASS line: /)
      }
      // A FAILED or not-proven entry is judged by its outcome (finishFake), not here.
      expect(W.rehearsalCoverage(rep(box({ outcome: 'FAILED', detail: 'ABORT: x' })))).toEqual([])
    })
  })

  describe('G3 the end of the box is one pure decision', () => {
    const clear = () => ({ settle: { changed: false, publicSummary: 'no change' }, lost: [], deepFail: false, audit: { ok: true, why: null }, where: 'box rehearsal, fake home' })
    it('settleVerdict: all clear is PASS; a changed settle is FAIL with the settle\'s words; each other reason alone', () => {
      need('settleVerdict')
      expect(W.settleVerdict(clear())).toEqual({ pass: true, why: null, line: null })
      const rows = [
        [{ settle: { changed: true, publicSummary: 'a protected folder changed: .cache is gone' } }, 'the settling compare found a change: a protected folder changed: .cache is gone'],
        [{ settle: { changed: true, publicSummary: '' } }, 'the settling compare found a change'],
        [{ settle: null }, 'the settling compare gave no reading'],
        [{ settle: { publicSummary: 'x' } }, 'the settling compare gave no reading'],
        [{ lost: ['.a is gone', '.b fell from 4 to 1 entries'] }, 'census loss: .a is gone; .b fell from 4 to 1 entries'],
        [{ lost: undefined }, 'the census gave no reading'],
        [{ deepFail: true }, 'the deep count fell by more than 2 %'],
        [{ deepFail: undefined }, 'the deep count gave no reading'],
        [{ audit: { ok: false, why: 'the audit has a gap or an open start' } }, 'the audit has a gap or an open start'],
        [{ audit: null }, 'the audit gave no verdict'],
      ]
      for (const [o, why] of rows) {
        const r = W.settleVerdict({ ...clear(), ...o })
        expect(r, why).toEqual({ pass: false, why, line: `[acceptance] RESULT: FAIL (box rehearsal, fake home): ${why}` })
      }
      // The first reason in order decides: the settle before the census, the census before the deep count, the deep count before the audit.
      expect(W.settleVerdict({ ...clear(), settle: { changed: true, publicSummary: 's' }, lost: ['.a is gone'], deepFail: true, audit: { ok: false, why: 'a' } }).why).toBe('the settling compare found a change: s')
      expect(W.settleVerdict({ ...clear(), lost: ['.a is gone'], deepFail: true, audit: { ok: false, why: 'a' } }).why).toBe('census loss: .a is gone')
      expect(W.settleVerdict({ ...clear(), deepFail: true, audit: { ok: false, why: 'a' } }).why).toBe('the deep count fell by more than 2 %')
      expect(W.settleVerdict({ ...clear(), where: 'real profile', audit: { ok: false, why: 'a' } }).line).toBe('[acceptance] RESULT: FAIL (real profile): a')
    })
    it('realBox calls it and prints its line', () => {
      const src = fnSource('async function realBox(')
      expect(src).toContain('const end = settleVerdict({ settle, lost, deepFail, audit: av, where })')
      expect(src).toContain('if (!end.pass) { say(end.line); return { code: 1 } }')
      expect(src).not.toMatch(/if \(settle\.changed \|\| lost\.length/)
    })
  })

  describe('G4 afterVerdict says what was seen when the audit records the refusal and the answer names no layer', () => {
    it('the row', () => {
      const r = W.afterVerdict({ isError: true, layer: 'containment', audit: good, decoys: 'intact' })
      expect(r.ok).toBe(false)
      expect(r.why).toBe('was refused (the audit records the protected path layer), but its answer does not name the layer (isError true, layer containment, audit {"refused":1,"start":0,"end":0,"layer":"protected path"}, decoys intact)')
      expect(W.afterVerdict({ isError: true, layer: null, audit: good, decoys: 'gone' }).why).toMatch(/^was refused \(the audit records the protected path layer\), but its answer does not name the layer \(isError true, layer none, .*decoys gone\)$/)
      // An audit that records no refusal is still "not refused".
      expect(W.afterVerdict({ isError: true, layer: 'containment', audit: { ...good, refused: 0, start: 1, end: 1 }, decoys: 'intact' }).why).toMatch(/^was not refused before it ran \(isError true, layer containment/)
    })
  })

  describe('G5 notProvenBlock, on a report shaped as the fake stage really printed it', () => {
    // The shape of `REPORT {...}` printed by `--stage fake --json` on 2026-11-24 (the wave 11 build's fake-1 run): its
    // keys, and its left-behind list verbatim. Entries are not read by the block.
    const LEFT = [{ surface: 'post-checkout', armed: 'armed', fired: false }, { surface: 'pre-commit', armed: 'armed', fired: false }, { surface: 'post-index-change', armed: 'armed', fired: false },
      { surface: 'fsmonitor', armed: 'armed', fired: false }, { surface: 'filter', armed: 'armed', fired: false }, { surface: 'textconv', armed: 'not armed on this git (git version 2.53.0.windows.2)', fired: false },
      { surface: 'diff-external', armed: 'armed', fired: false }, { surface: 'pager', armed: 'not armed on this git (git version 2.53.0.windows.2)', fired: false },
      { surface: 'conftest', armed: 'armed', fired: false, via: 'armed through the stand-in pytest in the fake user site' }]
    const report = () => ({ acknowledged: [], boxFolder: null, bun: '1.3.13', canary: {}, commit: { sha: '0'.repeat(40), dirty: true }, disarm: { ok: true, line: 'x' }, entries: [{ run: 1, id: 'x' }],
      firstFailure: null, incomplete: [], innerRuns: [{ run: 1 }], labelLeak: 'none', leftBehind: LEFT, links: [], liveFire: true, lowIntegrity: 'low', notProven: 14, notProvenOutside: 0,
      pass: true, platform: 'win32', realProfileLoss: false, realProfileUnmeasured: [], root: 'C:\\r', shell: 'powershell', stage: 'fake', tools: { shell: 'powershell', python: 'python', gitBash: 'C:\\g\\bash.exe' } })
    const o = { say: () => {}, commit: { sha: 'abc123', dirty: false }, lowLabelled: () => false, today: '2026-11-24' }
    const tools = { info: { displayName: 'Windows PowerShell 5.1' } }
    it('the eleven lines, the armed and the unarmed surfaces named from the report', () => {
      need('notProvenBlock')
      const said = []
      const lines = W.notProvenBlock({ calls: 14 }, [], report(), tools, 'C:\\m', { ...o, say: (l) => said.push(l) })
      expect(said).toEqual(lines)
      expect(lines).toHaveLength(12)
      expect(lines[0]).toBe('[acceptance] NOT PROVEN by this run:')
      expect(lines[2]).toBe(' (2) The path check reads text; these are 14 spellings of an unbounded set. A script written and then run is not read.')
      expect(lines[8]).toBe(' (8) Code a run leaves in its repository: the harness\'s own git calls are neutralised by a list of overrides, shown on the fake stage for the surfaces that list names (post-checkout, pre-commit, post-index-change, fsmonitor, filter, diff-external, conftest); textconv, pager did not fire on this git even unneutralised and are not proven either way.')
      expect(lines[10]).toBe(' (10) Files the run created: Low label after release no.')
      expect(lines[11]).toBe(' (11) Shown on this PC, on commit abc123, with Windows PowerShell 5.1, on 2026-11-24.')
    })
    it('it cannot throw on a report with no left-behind list, no entries, or no report at all', () => {
      const shapes = [{ ...report(), leftBehind: undefined }, { ...report(), leftBehind: null }, { ...report(), leftBehind: 'x' }, { ...report(), leftBehind: [null, 3, { armed: 'armed' }] },
        { ...report(), entries: undefined }, { ...report(), entries: [] }, {}, null, undefined]
      for (const r of shapes) {
        const lines = W.notProvenBlock({ calls: 0 }, [], r, tools, 'C:\\m', o)
        expect(lines, JSON.stringify(r)).toHaveLength(12)
      }
      expect(W.notProvenBlock({ calls: 0 }, [], { leftBehind: [] }, tools, 'C:\\m', o)[8]).toMatch(/names \(none\); none did not fire/)
      // No counts, no tools, no mission, a dirty commit: still twelve lines, in words.
      const bare = W.notProvenBlock(null, null, null, null, null, { ...o, commit: { sha: 'abc', dirty: null } })
      expect(bare[2]).toBe(' (2) The path check reads text; these are an unknown number of spellings of an unbounded set. A script written and then run is not read.')
      expect(bare[10]).toBe(' (10) Files the run created: Low label after release unknown (no mission folder was named).')
      expect(bare[11]).toBe(' (11) Shown on this PC, on commit abc, dirty: unknown, with an unknown tool shell, on 2026-11-24.')
    })
  })

  describe('G6 the engine\'s in-run presence tripwire (boot step 6) runs in the box', () => {
    it('tripwireLossLine: the ABORT line of a loss, with the latch, or of a latch already there', () => {
      need('tripwireLossLine')
      expect(W.tripwireLossLine({ loss: { kind: 'presence', publicSummary: 'a protected folder changed' }, latchPath: 'C:\\g\\HALT.json' }))
        .toBe('ABORT: the presence tripwire reported a loss: a protected folder changed. The integrity latch was written (C:\\g\\HALT.json). Nothing more was run.')
      expect(W.tripwireLossLine({ loss: { kind: 'latch', publicSummary: 'the integrity latch is present, or the guard folder can no longer be used' }, latchPath: null }))
        .toBe('ABORT: the presence tripwire reported a loss: the integrity latch is present, or the guard folder can no longer be used. The latch was not written by this box (it was there, or the guard folder cannot be used). Nothing more was run.')
      expect(W.tripwireLossLine({ loss: { kind: 'presence', publicSummary: 'x' }, latchPath: null })).toBe('ABORT: the presence tripwire reported a loss: x. The integrity latch could not be written. Nothing more was run.')
    })
    // Changed on purpose in wave 11c (H2): the start, the onLoss and the abort moved into boxTripwire (table tested in
    // T2.39 H2, where the order of start and stop in realBox is pinned by source position); this case keeps the rest.
    it('realBox starts it right after the models record, as engine/main.ts does, refuses by name when it cannot, and stops it in the finally block before the settle', () => {
      const src = fnSource('async function realBox(')
      const models = src.indexOf('const mr = I.checkModelsRecord()')
      const start = src.indexOf('const tw = trip.start(ctx)')
      expect(start).toBeGreaterThan(models)
      // Before the first reading of the home and the first child.
      expect(start).toBeLessThan(src.indexOf('const c0 = censusOf(home)'))
      expect(start).toBeLessThan(src.indexOf('viaToolExec('))
      expect(src).toContain('const trip = boxTripwire({ I, runId, page, say })')
      expect(src).toContain('say(tw.line)\n    if (!tw.ok) { code = 2; return { code } }')
      expect((src.match(/if \(await trip\.abort\(\)\)/g) ?? []).length).toBeGreaterThanOrEqual(5)
      const fin = src.slice(src.indexOf('} finally {'))
      expect(fin.indexOf('trip.stop()')).toBeGreaterThan(-1)
      expect(fin.indexOf('trip.stop()')).toBeLessThan(fin.indexOf('I.settleRun('))
      // And at the end of the box, before its own settle.
      const end = src.slice(src.indexOf('// G7: the end.'))
      expect(end.indexOf('trip.stop()')).toBeGreaterThan(-1)
      expect(end.indexOf('trip.stop()')).toBeLessThan(end.indexOf('const settle = await I.settleRun('))
    })
  })

  describe('G7 the registry reader, on the answer reg.exe really gave at low integrity on this PC', () => {
    it('reg add exit 1, stdout empty, stderr "ERROR: Access is denied.\\r\\r\\n" (measured 2026-11-24, w10 probe-low.out.txt), reg query exit 1 after: denied', () => {
      // realBox builds the output as `${added.stdout}\n${added.stderr}`.
      const added = { status: 1, stdout: '', stderr: 'ERROR: Access is denied.\r\r\n' }
      const plan = registryProbePlan({ key: 'HKCU\\Software\\cynco-review-probe-cmd-563154ab', before: false, after: false, refused: null, output: `${added.stdout}\n${added.stderr}` })
      expect(plan).toEqual({ abort: false, delete: false, line: 'preflight: a contained child was denied creating HKCU\\Software\\cynco-review-probe-cmd-563154ab (reg query finds no such key; reg add answered, lines joined: Access is denied)' })
    })
  })

  describe('G8 rehearsalRefusal refuses a test root that holds the machine\'s own folders', () => {
    const big = temp('cynco-acc-w11b-')
    writeFileSync(join(big, '.cynco-acceptance-root'), 'beefcafe')
    const inside = (base, rel) => join(base, ...rel.split('/'))
    const vOf = (base) => ({ home: inside(base, 'profile/Users/tester'), temp: inside(base, 'profile/Users/tester/AppData/Local/Temp'), state: inside(base, 'profile/Users/tester/.cynco'),
      guard: inside(base, 'guard'), audit: inside(base, 'audit'), models: inside(base, 'models'), sandboxRoot: inside(base, 'sandbox-root') })
    const outside = temp('cynco-acc-w11b-out-')
    const machineOut = [['the real home', join(outside, 'home')], ['the default guard folder', join(outside, 'cynco-guard')], ['the default audit folder', join(outside, 'cynco-audit')],
      ['the default sandbox root', join(outside, 'cynco-sandbox')], ['the default models folder', join(outside, 'home', '.cynco', 'models')]]
    const args = (o = {}) => ({ root: big, nonce: 'beefcafe', env: {}, readSentinel: (r) => readFileSync(join(r, '.cynco-acceptance-root'), 'utf8'), v: vOf(big), machine: machineOut, ...o })
    it('machine folders outside the root: null; each one inside it: refused by name', () => {
      need('rehearsalRefusal', 'machineFolders')
      expect(W.rehearsalRefusal(args())).toBeNull()
      for (const [i, [name]] of machineOut.entries()) {
        const p = join(big, `machine-${i}`)
        const machine = machineOut.map((m, j) => (j === i ? [m[0], p] : m))
        expect(W.rehearsalRefusal(args({ machine })), name).toBe(`the test root ${big} holds ${name} (${p}) by real path`)
      }
      // The root itself is one of them.
      expect(W.rehearsalRefusal(args({ machine: [['the real home', big]] }))).toBe(`the test root ${big} holds the real home (${big}) by real path`)
      expect(W.rehearsalRefusal(args({ machine: undefined }))).toBe('the machine\'s own folders are not known')
      expect(W.rehearsalRefusal(args({ machine: [] }))).toBe('the machine\'s own folders are not known')
      expect(W.rehearsalRefusal(args({ machine: [['the real home', '']] }))).toBe('the machine\'s own folders are not known')
    })
    it('by real path: a root that is a link to a folder holding the real home is refused', () => {
      const link = join(temp('cynco-acc-w11b-l-'), 'root-link')
      symlinkSync(big, link, WIN ? 'junction' : 'dir')
      linksToRemove.push(link)
      const home = join(big, 'realhome')
      expect(W.rehearsalRefusal(args({ root: link, v: vOf(link), machine: [['the real home', home]] }))).toBe(`the test root ${link} holds the real home (${home}) by real path`)
      expect(W.rehearsalRefusal(args({ root: link, v: vOf(link), machine: machineOut }))).toBeNull()
    })
    it('machineFolders: the real home as the system reports it and the defaults of engine/paths with no variable set', async () => {
      need('systemHome')
      const P = await import('../../engine/paths.js')
      const { userInfo } = await import('node:os')
      // Under Node (this suite) os.userInfo() asks the token's profile folder; under Bun it follows USERPROFILE (measured
      // 2026-11-24), which is why the runner asks userenv.dll there: T3's run 9 prints that answer and is checked below.
      expect(await W.systemHome()).toBe(userInfo().homedir)
      const m = W.machineFolders(P, await W.systemHome())
      // Changed on purpose in wave 11c (H4): the real home is marked 'holds' (a test root lies below it, in the temp
      // folder), and this process's own guard, audit, sandbox and models folders come before the code defaults.
      expect(m[0]).toEqual(['the real home', userInfo().homedir, 'holds'])
      // No home known: the refusal says the machine's folders are not known.
      expect(W.rehearsalRefusal(args({ machine: W.machineFolders(P, null) }))).toBe('the machine\'s own folders are not known')
      const named = W.machineFolders(P, 'C:\\H')
      const fold = (p) => (WIN ? resolve(p).toLowerCase() : resolve(p))
      const want = [
        ['the real home', 'C:\\H', 'holds'], ['the guard folder', P.guardDir()], ...(P.auditDir() ? [['the audit folder', P.auditDir()]] : []), ['the sandbox root', P.sandboxRoot()],
        ['the models folder', P.modelsDir()], ['the default guard folder', P.guardDir({})], ...(P.auditDir({}, process.platform) ? [['the default audit folder', P.auditDir({}, process.platform)]] : []),
        ['the default sandbox root', P.sandboxRoot({})], ['the default models folder', join('C:\\H', '.cynco', 'models')],
      ].filter((r, i, all) => all.findIndex(x => fold(x[1]) === fold(r[1])) === i)
      expect(named).toEqual(want)
      // In this suite the guard, audit and sandbox folders are the suite's own (never created), so the code defaults follow them.
      if (WIN) expect(named.map(x => x[1]).slice(-4)).toEqual(['C:/cynco-guard', 'C:/cynco-audit', 'C:/cynco-sandbox', join('C:\\H', '.cynco', 'models')])
    })
    // Changed on purpose in wave 11c (H4): the folders are the fake stage's, handed to inner run 9 by --machine; neither
    // rehearseBox nor realBox asks its own repointed process for them (T2.39 H4).
    it('rehearseBox and realBox both hand it the machine\'s folders', () => {
      expect(fnSource('async function rehearseBox(')).toContain('const why = rehearsalRefusal({ root, nonce, env: process.env, readSentinel: readSentinelOf, v: boxFolders(P), machine })')
      expect(fnSource('async function realBox(')).toContain('const machine = rehearsal.machine ?? null')
      expect(fnSource('async function realBox(')).toContain('const why = rehearsalRefusal({ root: rehearsal.root, nonce: rehearsal.nonce, env: process.env, readSentinel: readSentinelOf, v: boxFolders(P0), machine })')
      expect(runnerSource()).not.toMatch(/function machineFolders\(P, home = /)
    })
  })
})

describe('T2.39 wave 11c: what the mutation check of wave 11b left', () => {
  const W = acceptance
  const need = (...names) => { for (const n of names) expect(typeof W[n], `${n} is not exported`).not.toBe('undefined') }

  describe('H1 the real stage\'s home guard asks the system, never os.userInfo(), which follows USERPROFILE under Bun', () => {
    const OK = { argv: [REAL_PROFILE_FLAG], env: { [REAL_PROFILE_VAR]: '1' }, contained: false, level: 'medium', platform: 'win32', runtime: 'bun', unprotected: [], evidence: null, halt: null, lowLabelled: [] }
    const SYS_UNREAD = "[acceptance] REFUSED: the home folder as the system reports it (the profile folder of this process's token) could not be read; the real-profile stage does not take the environment's word for it — nothing was run"
    it('homesRefusal: the table (env and system differ: refused; equal: passes; system unknown: refused)', () => {
      need('homesRefusal')
      const rows = [
        // [what, homes, refusal or null]
        ['equal', { env: 'C:\\Users\\owner', system: 'C:\\Users\\owner' }, null],
        ['USERPROFILE repointed', { env: 'C:\\nowhere\\fake', system: 'C:\\Users\\owner' }, '[acceptance] REFUSED: the home folder is read two ways and they disagree (C:\\nowhere\\fake vs C:\\Users\\owner) — nothing was run'],
        ['the system answer unknown (null)', { env: 'C:\\Users\\owner', system: null }, SYS_UNREAD],
        ['the system answer unknown (empty)', { env: 'C:\\Users\\owner', system: '' }, SYS_UNREAD],
        ['the system answer unknown, the environment empty too', { env: '', system: null }, SYS_UNREAD],
        ['the system answer unknown, no environment either', {}, SYS_UNREAD],
        ['the environment names no home', { env: '', system: 'C:\\Users\\owner' }, '[acceptance] REFUSED: the environment names no home folder (USERPROFILE and HOME are not set); the system reports C:\\Users\\owner — nothing was run'],
      ]
      if (WIN) rows.push(['equal but for case (Windows)', { env: 'c:\\users\\OWNER', system: 'C:\\Users\\owner' }, null], ['equal but for a trailing separator (Windows)', { env: 'C:\\Users\\owner\\', system: 'C:\\Users\\owner' }, null])
      for (const [what, homes, want] of rows) expect(W.homesRefusal(homes), what).toBe(want)
      // Through rule G2 itself, in its place: after the latch, before the labels.
      expect(realStageRefusal({ ...OK, homes: { env: 'C:\\Users\\owner', system: null } })).toBe(SYS_UNREAD)
      expect(realStageRefusal({ ...OK, homes: { env: 'C:\\Users\\owner', system: 'C:\\Users\\owner' } })).toBeNull()
      expect(realStageRefusal({ ...OK, halt: 'latched', homes: { env: 'C:\\Users\\owner', system: null } })).toMatch(/REFUSED: integrity: latched/)
    })
    it('runRealStage hands the guard the system\'s answer, and runFakeStage reads the real profile at it; neither asks os.userInfo()', () => {
      const real = fnSource('export async function runRealStage(')
      expect(real).toContain('const sysHome = await systemHome()')
      expect(real).toContain("homes: { env: process.env.USERPROFILE ?? process.env.HOME ?? '', system: sysHome }")
      // The guard is asked before the evidence file is opened and before step 0.
      expect(real.indexOf('const sysHome = await systemHome()')).toBeLessThan(real.indexOf('homes: {'))
      expect(real.indexOf('if (why) { say(why); return { code: 2 } }')).toBeLessThan(real.indexOf('evidenceFd = openSync('))
      expect(real).not.toMatch(/userInfo\(\)\.homedir/)
      const fakeStage = fnSource('export async function runFakeStage(')
      expect(fakeStage).toContain('const realHome = await systemHome()')
      expect(fakeStage).not.toMatch(/userInfo\(\)\.homedir/)
      // Unread, the real profile is not read at another folder: it is named not measured.
      expect(fakeStage).toContain("unmeasured('the real home as the system reports it could not be read (systemHome)')")
      expect(fakeStage).toContain('if (realHome !== null) reading0 = realHomeReading(I, realHome)')
      // The fake stage's evidence file: refused inside the home the system reports and inside the one the environment names.
      const fakeM = fnSource('async function fakeMain(')
      expect(fakeM).toContain("const evidence = typeof evPath === 'string' ? evidenceIn(await systemHome()) ?? evidenceIn(os.homedir()) : null")
      expect(fakeM).not.toMatch(/userInfo\(\)\.homedir/)
      // systemHome is the one place in the runner that asks os.userInfo() as code (comments aside; realBox's G5 lines
      // spell it in quotes, for a child to run).
      const code = runnerSource().split('\n').filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
      const hits = code.filter(l => /(?<!['"`])\bos\.userInfo\(\)/.test(l)).map(l => l.trim())
      expect(hits, 'os.userInfo() asked as code').toEqual(['return os.userInfo().homedir'])
      expect(fnSource('export async function systemHome(')).toContain('return os.userInfo().homedir')
    })
    it('homesRefusal reads the repointed case the way the scratch probe measured it under Bun (systemHome answered the real home)', () => {
      // Measured 2026-11-24 (C:\cynco-recovery-2026-11-22\phase3\w11\scratch\build-c\home-probe.out.txt), Bun 1.3.13 with
      // USERPROFILE=C:\nowhere\fake in that child only: os.homedir() and os.userInfo().homedir answered C:\nowhere\fake,
      // systemHome() C:\Users\civer.
      expect(W.homesRefusal({ env: 'C:\\nowhere\\fake', system: 'C:\\Users\\civer' })).toMatch(/disagree \(C:\\nowhere\\fake vs C:\\Users\\civer\)/)
      expect(W.homesRefusal({ env: 'C:\\nowhere\\fake', system: 'C:\\nowhere\\fake' }), 'what the guard compared before wave 11c: the environment with itself').toBeNull()
    })
  })

  describe('H2 the box\'s tripwire, as one tested function', () => {
    const ctx = { runId: 'acceptance-real-x', folders: { guard: 'C:\\fake\\guard' }, missionCwd: 'C:\\fake\\mission' }
    const page = async () => false
    const LATCH = 'C:\\fake\\guard\\HALT.json'
    const stub = (o = {}) => {
      const seen = { starts: [], halts: [], stops: 0, onLoss: null }
      const I = {
        // Wave 11d, K5 (P6): "no answer given" (the default, ok) is told apart from an engine answer of undefined.
        startPresenceTripwire: (a) => { seen.starts.push(a); seen.onLoss = a.onLoss; return 'answer' in o ? o.answer : { ok: true, stop: () => {}, folders: 30, roots: 11 } },
        tripHalt: (x) => { seen.halts.push(x); return Promise.resolve(o.halt ?? { latched: true, alreadyLatched: false, paged: false, latchPath: LATCH }) },
        stopPresenceTripwire: () => { seen.stops++ },
      }
      const said = []
      const trip = W.boxTripwire({ I, runId: ctx.runId, page, say: (l) => said.push(l) })
      return { I, seen, said, trip }
    }
    const presence = { kind: 'presence', summary: 'a protected folder changed: .cache is gone', publicSummary: 'a protected folder changed', compare: { changed: true } }
    const latchLoss = { kind: 'latch', summary: 'the integrity latch is present', publicSummary: 'the integrity latch is present, or the guard folder can no longer be used', compare: null }
    it('start: the engine\'s tripwire over the box\'s ctx with an onLoss; the "tripwire on" line; nothing stopped, nothing latched', () => {
      need('boxTripwire')
      const { seen, said, trip } = stub()
      const tw = trip.start(ctx)
      expect(tw).toEqual({ ok: true, line: '[acceptance] tripwire on: 30 folder(s) under 11 root(s), every 60 s and before a tool call through the executor (at most once a second)' })
      expect(seen.starts).toHaveLength(1)
      expect(seen.starts[0].ctx).toBe(ctx)
      expect(typeof seen.starts[0].onLoss).toBe('function')
      expect([seen.halts.length, seen.stops, said.length]).toEqual([0, 0, 0])
    })
    it('no loss: abort() answers false and prints nothing', async () => {
      const { said, trip } = stub()
      trip.start(ctx)
      expect(await trip.abort()).toBe(false)
      expect(await trip.abort()).toBe(false)
      expect(said).toEqual([])
    })
    it('a presence loss: tripHalt once, with the box\'s run, guard, mission folder and page adapter; abort() prints the ABORT line once and answers true twice', async () => {
      const { seen, said, trip } = stub()
      trip.start(ctx)
      seen.onLoss(presence)
      expect(seen.halts).toHaveLength(1)
      expect(seen.halts[0]).toEqual({ by: 'acceptance', run: 'acceptance-real-x', reason: 'presence-lost', compare: { changed: true }, detail: presence.summary, guard: 'C:\\fake\\guard', cwd: 'C:\\fake\\mission', page })
      expect(seen.halts[0].page).toBe(page)
      expect(await trip.abort()).toBe(true)
      expect(said).toEqual([`[acceptance] ABORT: the presence tripwire reported a loss: a protected folder changed. The integrity latch was written (${LATCH}). Nothing more was run.`])
      expect(await trip.abort()).toBe(true)
      expect(said).toHaveLength(1)
      // A second report (the engine sends one per process) neither latches again nor changes the line.
      seen.onLoss({ ...presence, publicSummary: 'other' })
      expect(seen.halts).toHaveLength(1)
      expect(await trip.abort()).toBe(true)
      expect(said).toHaveLength(1)
      expect(seen.stops).toBe(0)
    })
    it('a presence loss with no compare hands tripHalt none; a latch that could not be written is said so', async () => {
      const { seen, said, trip } = stub({ halt: { latched: false, alreadyLatched: false, paged: false, latchPath: LATCH } })
      trip.start(ctx)
      seen.onLoss({ ...presence, compare: null })
      expect(seen.halts[0].compare).toBeUndefined()
      expect(Object.prototype.hasOwnProperty.call(seen.halts[0], 'compare')).toBe(true)
      expect(await trip.abort()).toBe(true)
      expect(said).toEqual(['[acceptance] ABORT: the presence tripwire reported a loss: a protected folder changed. The integrity latch could not be written. Nothing more was run.'])
    })
    it('a loss of the other kind the engine reports (the latch already there): the box writes no latch, and still aborts', async () => {
      const { seen, said, trip } = stub()
      trip.start(ctx)
      seen.onLoss(latchLoss)
      expect(seen.halts).toEqual([])
      expect(await trip.abort()).toBe(true)
      expect(said).toEqual(['[acceptance] ABORT: the presence tripwire reported a loss: the integrity latch is present, or the guard folder can no longer be used. The latch was not written by this box (it was there, or the guard folder cannot be used). Nothing more was run.'])
      expect(await trip.abort()).toBe(true)
      expect(said).toHaveLength(1)
    })
    it('a tripwire that cannot start gives the refusal, by name', async () => {
      const { said, trip } = stub({ answer: { ok: false, reason: 'no integrity baseline exists for run acceptance-real-x; the starter takes it before the engine starts' } })
      expect(trip.start(ctx)).toEqual({ ok: false, line: '[acceptance] REFUSED: integrity: no integrity baseline exists for run acceptance-real-x; the starter takes it before the engine starts — nothing was run' })
      // Changed on purpose in wave 11d (K5, P6): this row read ok only because the stub turned undefined into its default
      // answer; an engine answer of undefined is now handed through, and the box refuses it by name.
      expect(stub({ answer: undefined }).trip.start(ctx)).toEqual({ ok: false, line: '[acceptance] REFUSED: integrity: the presence tripwire gave no answer — nothing was run' })
      expect(stub({ answer: null }).trip.start(ctx)).toEqual({ ok: false, line: '[acceptance] REFUSED: integrity: the presence tripwire gave no answer — nothing was run' })
      expect(stub().trip.start(ctx).ok, 'no answer given: the stub\'s default').toBe(true)
      expect(stub({ answer: { ok: false } }).trip.start(ctx)).toEqual({ ok: false, line: '[acceptance] REFUSED: integrity: the presence tripwire gave no answer — nothing was run' })
      expect(await trip.abort()).toBe(false)
      expect(said).toEqual([])
    })
    it('stop() stops the engine\'s tripwire', () => {
      const { seen, trip } = stub()
      trip.start(ctx)
      trip.stop()
      expect(seen.stops).toBe(1)
    })
    it('realBox: one boxTripwire, started after the models record and before the first child; stopped exactly twice, after the attacks (before the box\'s settle) and in the finally block (before its settle)', () => {
      const src = fnSource('async function realBox(')
      expect((src.match(/boxTripwire\(/g) ?? []).length).toBe(1)
      // Made before the box's try block, so that its finally block can stop it on every path.
      expect(src.indexOf('const trip = boxTripwire({ I, runId, page, say })')).toBeGreaterThan(-1)
      expect(src.indexOf('const trip = boxTripwire({ I, runId, page, say })')).toBeLessThan(src.indexOf('  try {\n    // G4 step 3.'))
      // The engine's tripwire is reached only through it.
      expect(src).not.toMatch(/I\.(?:start|stop)PresenceTripwire\(/)
      expect(src).not.toMatch(/I\.tripHalt\(\{ by: 'acceptance', run: runId, reason: 'presence-lost', compare: loss/)
      const at = (s, from = 0) => { const i = src.indexOf(s, from); expect(i, s).toBeGreaterThan(-1); return i }
      const stops = [...src.matchAll(/trip\.stop\(\)/g)].map(m => m.index)
      expect(stops, 'trip.stop() in realBox').toHaveLength(2)
      const order = [
        ['the models record', at('const mr = I.checkModelsRecord()')],
        ['the start', at('const tw = trip.start(ctx)')],
        ['the executor', at('new X.ToolExecutor(')],
        ['the first child', at('viaToolExec(')],
        ['the first attack call', at('const r = await call(ex, v.call.tool, v.call.input)')],
        ['the attacks', at('for (const id of ATTACK_ORDER) {')],
        ['the first stop', stops[0]],
        ['the box\'s settle', at('const settle = await I.settleRun(')],
        ['the finally block', at('} finally {')],
        ['the second stop', stops[1]],
        ['the settling compare', at('const s = await I.settleRun(', at('} finally {'))],
      ]
      for (let i = 1; i < order.length; i++) expect(order[i - 1][1], `${order[i - 1][0]} before ${order[i][0]}`).toBeLessThan(order[i][1])
      // After the first look, after G5's first facts, after the honest work, in after(), before each attack, at the end.
      expect((src.match(/if \(await trip\.abort\(\)\) return/g) ?? []).length).toBe(6)
    })
  })

  describe('H3 the settle that settleVerdict reads is settleRun\'s answer itself', () => {
    it('the statement whole, declared once, never written to before settleVerdict reads it', () => {
      const src = fnSource('async function realBox(')
      expect(src).toMatch(/^ {4}const settle = await I\.settleRun\(runId, \{ by: 'acceptance', page \}\)$/m)
      expect((src.match(/\b(?:const|let|var) settle\b/g) ?? []).length).toBe(1)
      const decl = src.indexOf("const settle = await I.settleRun(runId, { by: 'acceptance', page })\n")
      const use = src.indexOf('const end = settleVerdict({ settle, lost, deepFail, audit: av, where })')
      expect(decl).toBeGreaterThan(-1)
      expect(use).toBeGreaterThan(decl)
      const between = src.slice(src.indexOf('\n', decl), use)
      expect(between, 'settle written to before settleVerdict').not.toMatch(/\bsettle\b\s*(?:\.\s*\w+\s*|\[[^\]]*\]\s*)?(?:[-+*/|&?]?=(?!=)|\+\+|--)/)
      expect(between).not.toMatch(/Object\.(?:assign|defineProperty)\(\s*settle\b/)
      expect(between).not.toMatch(/delete\s+settle\b/)
      expect(between).toContain("say(`${TAG} settle: ${settle.changed ? `CHANGED: ${settle.publicSummary}` : 'unchanged'}`)")
      expect((src.match(/settleVerdict\(/g) ?? []).length).toBe(1)
    })
  })

  describe('H4 the root guard in both directions, against the fake stage\'s own folders handed to run 9', () => {
    const host = temp('cynco-acc-w11c-host-')
    const root = join(host, 'root')
    mkdirSync(root)
    writeFileSync(join(root, '.cynco-acceptance-root'), 'beefcafe')
    const inside = (base, rel) => join(base, ...rel.split('/'))
    const vOf = (base) => ({ home: inside(base, 'profile/Users/tester'), temp: inside(base, 'profile/Users/tester/AppData/Local/Temp'), state: inside(base, 'profile/Users/tester/.cynco'),
      guard: inside(base, 'guard'), audit: inside(base, 'audit'), models: inside(base, 'models'), sandboxRoot: inside(base, 'sandbox-root') })
    const away = temp('cynco-acc-w11c-away-')
    const machineAway = [['the real home', join(away, 'home'), 'holds'], ['the guard folder', join(away, 'guard')], ['the audit folder', join(away, 'audit')], ['the sandbox root', join(away, 'sandbox')], ['the models folder', join(away, 'models')]]
    const args = (o = {}) => ({ root, nonce: 'beefcafe', env: {}, readSentinel: (r) => readFileSync(join(r, '.cynco-acceptance-root'), 'utf8'), v: vOf(root), machine: machineAway, ...o })
    it('rows: a root inside each of the guard, audit, sandbox and models folders is refused; inside the real home it passes; holding any of them it is refused', () => {
      need('rehearsalRefusal')
      expect(W.rehearsalRefusal(args())).toBeNull()
      for (const [i, [name]] of machineAway.entries()) {
        const machine = machineAway.map((m, j) => (j === i ? [m[0], host, ...m.slice(2)] : m))
        const want = name === 'the real home' ? null : `the test root ${root} lies inside ${name} (${host}) by real path`
        expect(W.rehearsalRefusal(args({ machine })), name).toBe(want)
        const held = machineAway.map((m, j) => (j === i ? [m[0], join(root, 'x'), ...m.slice(2)] : m))
        expect(W.rehearsalRefusal(args({ machine: held })), `${name} held`).toBe(`the test root ${root} holds ${name} (${join(root, 'x')}) by real path`)
      }
      // A home row without the mark is judged both ways (the mark exempts the real home from one direction only).
      expect(W.rehearsalRefusal(args({ machine: [['the real home', host]] }))).toBe(`the test root ${root} lies inside the real home (${host}) by real path`)
      // The code defaults' shapes: a root under C:\cynco-guard or C:\cynco-sandbox (lexically; nothing is made there).
      if (WIN) {
        for (const d of ['C:\\cynco-guard', 'C:\\cynco-sandbox']) {
          const r = join(d, 'acc-root')
          expect(W.rehearsalRefusal({ ...args(), root: r, v: vOf(r), readSentinel: () => 'beefcafe', machine: [['the default guard folder', 'C:/cynco-guard'], ['the default sandbox root', 'C:/cynco-sandbox']] }), d)
            .toMatch(/^the test root .* lies inside the default (?:guard folder|sandbox root) \(C:\/cynco-(?:guard|sandbox)\) by real path$/)
        }
      }
    })
    it('by real path: a root reached through a link that lands inside a machine folder is refused', () => {
      const linkBase = temp('cynco-acc-w11c-l-')
      const link = join(linkBase, 'root-link')
      symlinkSync(root, link, WIN ? 'junction' : 'dir')
      linksToRemove.push(link)
      expect(W.rehearsalRefusal(args({ root: link, v: vOf(link), machine: [['the guard folder', host]] }))).toBe(`the test root ${link} lies inside the guard folder (${host}) by real path`)
      expect(W.rehearsalRefusal(args({ root: link, v: vOf(link) }))).toBeNull()
    })
    it('machineFoldersFrom: what --machine carries, or null (a by-hand --inner box is handed nothing, and refuses)', () => {
      need('machineFoldersFrom')
      expect(W.machineFoldersFrom(JSON.stringify(machineAway))).toEqual(machineAway)
      for (const bad of [undefined, null, '', 'x', '{}', '[]', '[["a"]]', '[["a",""]]', '[["","b"]]', '[["a","b","both"]]', '[["a","b","holds","x"]]', '[["a",1]]', '"C:\\\\"']) {
        expect(W.machineFoldersFrom(bad), String(bad)).toBeNull()
      }
      expect(W.rehearsalRefusal(args({ machine: W.machineFoldersFrom(undefined) }))).toBe('the machine\'s own folders are not known')
    })
    it('machineFolders: this process\'s own four folders first, then the code defaults not already named', () => {
      const P = { guardDir: (e) => (e ? 'C:/cynco-guard' : 'C:/own/guard'), auditDir: (e) => (e ? 'C:/cynco-audit' : 'C:/own/audit'), sandboxRoot: (e) => (e ? 'C:/cynco-sandbox' : 'C:/own/sandbox'), modelsDir: () => 'C:/cynco-models' }
      expect(W.machineFolders(P, 'C:\\H')).toEqual([
        ['the real home', 'C:\\H', 'holds'], ['the guard folder', 'C:/own/guard'], ['the audit folder', 'C:/own/audit'], ['the sandbox root', 'C:/own/sandbox'], ['the models folder', 'C:/cynco-models'],
        ['the default guard folder', 'C:/cynco-guard'], ['the default audit folder', 'C:/cynco-audit'], ['the default sandbox root', 'C:/cynco-sandbox'], ['the default models folder', join('C:\\H', '.cynco', 'models')],
      ])
      // This PC as the owner's shell sees it: the defaults for three, the models folder named by its variable.
      const same = { guardDir: () => 'C:/cynco-guard', auditDir: () => 'C:/cynco-audit', sandboxRoot: () => 'C:/cynco-sandbox', modelsDir: () => 'C:\\cynco-models' }
      expect(W.machineFolders(same, 'C:\\Users\\o')).toEqual([
        ['the real home', 'C:\\Users\\o', 'holds'], ['the guard folder', 'C:/cynco-guard'], ['the audit folder', 'C:/cynco-audit'], ['the sandbox root', 'C:/cynco-sandbox'], ['the models folder', 'C:\\cynco-models'],
        ['the default models folder', join('C:\\Users\\o', '.cynco', 'models')],
      ])
      // Round trip through the argument.
      expect(W.machineFoldersFrom(JSON.stringify(W.machineFolders(P, 'C:\\H')))).toEqual(W.machineFolders(P, 'C:\\H'))
    })
    it('startInner puts them on the command line (never in the environment), for the box rehearsal only', () => {
      const seen = []
      const machine = [['the real home', 'C:\\Users\\o', 'holds'], ['the models folder', 'C:\\cynco-models']]
      startInner({ mode: 'box', phase: 'rehearsal' }, 'R', 'N', { A: '1' }, (cmd, args, o) => { seen.push({ cmd, args, o }); return { status: 0, stdout: '', stderr: '' } }, machine)
      expect(seen[0].args.slice(2)).toEqual(['--inner', 'box', '--phase', 'rehearsal', '--root', 'R', '--nonce', 'N', '--machine', JSON.stringify(machine)])
      expect(seen[0].o.env).toEqual({ A: '1' })
      const fakeStage = fnSource('export async function runFakeStage(')
      expect(fakeStage).toContain("const r = spec.run === REHEARSAL_RUN\n      ? startInner(spec, root, nonce, env, runSync, machineFolders(await import('../engine/paths.js'), realHome))\n      : startInner(spec, root, nonce, env)")
      expect(fnSource('function parseArgs(')).toContain("'--machine'")
      // The inner run asks its own repointed process for none of them.
      for (const decl of ['async function rehearseBox(', 'async function realBox(']) {
        expect(fnSource(decl), decl).not.toMatch(/machineFolders\(|systemHome\(/)
      }
    })
  })
})

describe('T2.11 an inner run is started once, never retried', () => {
  it('startInner hands the runner no retry option, the checkout as its folder and the exact environment', () => {
    const seen = []
    const r = startInner({ mode: 'full', phase: 'mission' }, 'R', 'N', { A: '1' }, (cmd, args, o) => { seen.push({ cmd, args, o }); return { status: 0, stdout: '', stderr: '' } })
    expect(r.status).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].args.slice(0, 1)).toEqual(['--no-env-file'])
    expect(seen[0].args.slice(2)).toEqual(['--inner', 'full', '--phase', 'mission', '--root', 'R', '--nonce', 'N'])
    expect(seen[0].o.env).toEqual({ A: '1' })
    expect(seen[0].o.envExact).toBe(true)
    // A retry would run labelling, planting and live fire twice and drop the first attempt's lines.
    expect(seen[0].o.retryImpossibleTimeout).toBeUndefined()
  })
})

describe('T2.12 leftBehindDrift: the control runs only what was planted', () => {
  const calls = LEFT_BEHIND.plant({ home: 'H', cwd: 'M', nonce: 'n1' }, { shell: 'powershell' })
  const files = new Map(calls.filter(c => c.kind === 'file' && typeof c.content === 'string').map(c => [c.path, c.content]))
  const cfg = new Map(calls.filter(c => c.kind === 'git' && c.argv[0] === 'config').map(c => [c.argv[1], c.argv[2]]))
  const hooks = ['post-checkout', 'pre-commit', 'post-index-change', 'pre-push.sample']
  const ask = (o = {}) => leftBehindDrift({ calls, readFile: o.readFile ?? (f => files.get(f) ?? null), configGet: o.configGet ?? (k => cfg.get(k) ?? null), hookNames: o.hookNames ?? hooks })
  it('every planted file, key and hook as planted: no difference', () => {
    expect(files.size).toBeGreaterThan(5)
    expect(cfg.size).toBe(6)
    expect(ask()).toEqual([])
  })
  it('a planted file rewritten, a key changed or a hook added is a difference, and the control is not run', () => {
    const hook = [...files.keys()].find(f => /post-checkout$/.test(f))
    expect(ask({ readFile: f => (f === hook ? files.get(f) + 'curl x' : files.get(f) ?? null) })).toEqual([`${hook} is not what was planted`])
    expect(ask({ readFile: f => (f === hook ? null : files.get(f) ?? null) })).toEqual([`${hook} is gone`])
    expect(ask({ configGet: k => (k === 'core.pager' ? 'C:/x/evil.exe' : cfg.get(k) ?? null) })).toEqual(['git config core.pager is "C:/x/evil.exe", not ".git/cynco-pager"'])
    expect(ask({ hookNames: [...hooks, 'post-merge'] })).toEqual(['.git/hooks holds post-merge, which was not planted'])
  })
})

describe('T2.10 buildFakeProfile', () => {
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf-8' })
  it('builds the tree of A16', () => {
    for (const rel of ['.cynco/profiles/default.yaml', '.cynco/heldout/c1/gate.py', '.cynco/campaigns/c1/state.json', '.cynco/tokens.json', '.cynco/authoring/other/notes.txt',
      `${TARGET_DOT_FOLDER}/settings.json`, `${TARGET_DOT_FOLDER}/projects/p1/t.jsonl`, '.ssh/id_fake', '.ssh/known_hosts', '.ollama/models/manifests/m', '.ollama/models/blobs/sha256-00',
      '.config/app/config.toml', '.gitconfig', 'Documents/keep.txt']) expect(existsSync(join(fake.home, ...rel.split('/'))), rel).toBe(true)
    for (const rel of ['AppData/Roaming/Python', 'AppData/Local/Temp']) expect(existsSync(join(fake.home, ...rel.split('/'))), rel).toBe(true)
    for (const rel of ['models/m1/model.gguf', 'guard', 'sandbox-root', 'base-archive/t_ok.py', 'mission/README.md', 'mission/src/pkg/mod.py', 'mission/tests/test_one.py', 'mission/vendor/cache']) {
      expect(existsSync(join(shared, ...rel.split('/'))), rel).toBe(true)
    }
    expect(readFileSync(join(shared, '.cynco-acceptance-root'), 'utf8')).toBe(NONCE)
    expect(readdirSync(fake.guard)).toEqual([])
  })
  it('the marker in audit/ is the one engine/audit/toolAudit.ts requires', () => {
    expect(readdirSync(fake.audit)).toEqual([AUDIT_MARKER])
  })
  it('mission/ and .cynco/authoring/a1 are git repositories whose top level is themselves', () => {
    for (const d of [fake.mission, fake.a1, fake.missionLinked]) {
      const r = git(d, ['rev-parse', '--show-toplevel'])
      expect(r.status, r.stderr).toBe(0)
      expect(resolve(r.stdout.trim()).toLowerCase()).toBe(resolve(d).toLowerCase())
    }
  })
  it.skipIf(fake.linkError !== null)('the link is three levels down in mission/ and at the top of mission-linked/', () => {
    expect(fake.links).toEqual([join(shared, 'mission', 'vendor', 'cache', 'linked-out'), join(shared, 'mission-linked', 'linked-out')])
    for (const l of fake.links) expect(lstatSync(l).isSymbolicLink(), l).toBe(true)
  })
  if (fake.linkError !== null) console.log(`[test] the link case is skipped: ${fake.linkError}`)
  it('a second call on the same root throws', () => {
    expect(() => buildFakeProfile(shared, NONCE)).toThrow(/not empty/)
  })
})

// ─── T3: the one Bun spawn of the fake stage ─────────────────────────────────────────────────

/** bun's full path, so that it is started without a shell and a timeout ends the orchestrator itself. */
const bunPath = (() => {
  const r = WIN
    ? spawnSync('where.exe', ['bun'], { encoding: 'utf-8', windowsHide: true })
    : spawnSync('/bin/sh', ['-c', 'command -v bun'], { encoding: 'utf-8' })
  const first = String(r.stdout ?? '').split(/\r?\n/).map(l => l.trim()).find(l => l !== '' && (!WIN || /\.exe$/i.test(l)))
  return r.status === 0 && first ? first : null
})()
if (!bunPath) console.log('[test] T3 is skipped: bun is not on the PATH')

/** The test-root paths of the fake profile the orchestrator builds (A16), for the catalog's `p`. */
const fakeP = (root) => {
  const home = join(root, 'profile', 'Users', 'tester')
  return {
    home, cwd: join(root, 'mission'), scratch: join(root, 'sandbox-root', 'run', 'scratch'), linked: join(root, 'mission', 'vendor', 'cache', 'linked-out'),
    guard: join(root, 'guard'), audit: join(root, 'audit'), models: join(root, 'models'), sandboxRootOther: join(root, 'sandbox-root', 'other'), nonce: '00000000',
  }
}

/**
 * What the full stack answers, in run 3, to the junction from the run's scratch folder to its mission
 * folder (R15 a): the path check's verdict on it, pinned in engine/__tests__/tools/containmentAttacks.test.ts
 * ("the junction from the scratch folder to the mission folder"). Change both together.
 */
const RUN_FOLDERS_ANSWER = 'allowed'
/** How realBox's rehearsal line begins (wave 11, with the machine's folders since wave 11b). */
const REHEARSAL_FOLDERS_LINE = '[acceptance] rehearsal: the home, temp, state, guard, audit, models and sandbox folders all lie inside the test root '
/** Where that line's list of the machine's own folders begins (wave 11c, H5: the only part T3's stray-path check leaves out). */
const MACHINE_FOLDERS_MARK = "the machine's own folders lie outside it: "

describe('T2.40 wave 11d: what the review of wave 11c left', () => {
  const W = acceptance
  const need = (...names) => { for (const n of names) expect(typeof W[n], `${n} is not exported`).not.toBe('undefined') }
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /** How often `line` stands in `text` as a whole line, its indentation included. */
  const wholeLines = (text, line) => (text.match(new RegExp(`^${esc(line)}$`, 'gm')) ?? []).length

  describe('K1 the box\'s census counts by the engine\'s rule (review F1)', () => {
    it('the runner\'s copy of the engine\'s transient names is the engine\'s TRANSIENT_NAME, by source and flags', () => {
      need('TRANSIENT_NAME')
      expect(W.TRANSIENT_NAME).toBeInstanceOf(RegExp)
      expect(W.TRANSIENT_NAME.source).toBe(integrity.TRANSIENT_NAME.source)
      expect(W.TRANSIENT_NAME.flags).toBe(integrity.TRANSIENT_NAME.flags)
    })
    it('censusOf leaves out a transient top-level name and counts a folder\'s children without them', () => {
      const h = temp('cynco-acc-w11d-census-')
      const dir = (n, kids = []) => { mkdirSync(join(h, n)); for (const k of kids) writeFileSync(join(h, n, k), 'x') }
      writeFileSync(join(h, '.gitconfig.lock'), 'x')
      writeFileSync(join(h, '.desk-tool.json.tmp'), 'x')
      dir('.x.tmp', ['a'])
      dir('.withlock', ['a', 'b.lock', 'c.swp'])
      dir('.onlylock', ['a.lock'])
      dir('.keep', ['a', 'b'])
      writeFileSync(join(h, '.file'), 'x')
      expect(censusOf(h)).toEqual(['.file\tfile\t0', '.keep\tdir\t2', '.onlylock\tdir\t0', '.withlock\tdir\t1'])
    })
    it('rows: what the box reads as a loss between its first reading and a later one', () => {
      const h = temp('cynco-acc-w11d-loss-')
      const dir = (n, kids = []) => { mkdirSync(join(h, n)); for (const k of kids) writeFileSync(join(h, n, k), 'x') }
      writeFileSync(join(h, '.gitconfig.lock'), 'x')
      dir('.x.tmp', ['a'])
      dir('.empty')
      dir('.onlylock', ['a.lock'])
      dir('.one', ['a'])
      dir('.emptied', ['a'])
      dir('.withlock', ['a', 'b.lock'])
      dir('.keep', ['a', 'b'])
      writeFileSync(join(h, '.file'), 'x')
      const c0 = censusOf(h)
      // Each change alone, then read again: [what, change, the loss it is].
      const rows = [
        ['a transient dot-file there at the first reading and gone', () => unlinkSync(join(h, '.gitconfig.lock')), []],
        ['a transient dot-folder there at the first reading and gone', () => { unlinkSync(join(h, '.x.tmp', 'a')); rmdirSync(join(h, '.x.tmp')) }, []],
        ['a folder empty at the first reading and gone', () => rmdirSync(join(h, '.empty')), []],
        ['a folder whose only child was transient, gone', () => { unlinkSync(join(h, '.onlylock', 'a.lock')); rmdirSync(join(h, '.onlylock')) }, []],
        ['a folder whose only change is a transient child gone', () => unlinkSync(join(h, '.withlock', 'b.lock')), []],
        ['a folder with one entry emptied', () => unlinkSync(join(h, '.emptied', 'a')), ['.emptied fell from 1 to 0 entries']],
        ['a folder with one entry gone', () => { unlinkSync(join(h, '.one', 'a')); rmdirSync(join(h, '.one')) }, ['.emptied fell from 1 to 0 entries', '.one is gone']],
        ['a dot-file gone', () => unlinkSync(join(h, '.file')), ['.emptied fell from 1 to 0 entries', '.file is gone', '.one is gone']],
      ]
      for (const [what, change, want] of rows) {
        change()
        expect(W.censusLoss(c0, censusOf(h)), what).toEqual(want)
      }
    })
    it('censusLoss: a folder with no children at the first reading is not compared; one that could not be listed (-1) still is, for "gone"', () => {
      expect(W.censusLoss(['.e\tdir\t0'], [])).toEqual([])
      expect(W.censusLoss(['.e\tdir\t0'], ['.e\tdir\t0'])).toEqual([])
      expect(W.censusLoss(['.u\tdir\t-1'], [])).toEqual(['.u is gone'])
      expect(W.censusLoss(['.u\tdir\t-1'], ['.u\tdir\t-1'])).toEqual([])
      // A file and a link record 0 children and are still compared, as the engine compares every entry but an empty folder.
      expect(W.censusLoss(['.f\tfile\t0', '.j\tlink\t0\tC:\\t'], [])).toEqual(['.f is gone', '.j is gone'])
      expect(W.censusLoss(['.d\tdir\t1'], ['.d\tdir\t0'])).toEqual(['.d fell from 1 to 0 entries'])
      expect(W.censusLoss(['.d\tdir\t4'], ['.d\tdir\t2'])).toEqual([])
    })
    // The check of wave 11d (D2): the engine reads a folder it can no longer count as emptied only when it held two
    // entries or more (diffPresence: `if (x.n === null) { if (e.n >= 2) ...`); the box was stricter by one.
    it('censusLoss: a folder that can no longer be listed (-1 at the later reading) is a loss only when it held two entries or more, as the engine reads it', () => {
      expect(W.censusLoss(['.d\tdir\t1'], ['.d\tdir\t-1'])).toEqual([])
      expect(W.censusLoss(['.d\tdir\t2'], ['.d\tdir\t-1'])).toEqual(['.d fell from 2 to -1 entries'])
      expect(W.censusLoss(['.d\tdir\t10'], ['.d\tdir\t-1'])).toEqual(['.d fell from 10 to -1 entries'])
      // Countable readings are as before: one entry emptied is a loss, half kept is none.
      expect(W.censusLoss(['.d\tdir\t1'], ['.d\tdir\t0'])).toEqual(['.d fell from 1 to 0 entries'])
      expect(W.censusLoss(['.d\tdir\t3'], ['.d\tdir\t1'])).toEqual(['.d fell from 3 to 1 entries'])
      expect(W.censusLoss(['.d\tdir\t2'], ['.d\tdir\t1'])).toEqual([])
      // confirmedLoss reads the words unchanged.
      expect(W.confirmedLoss(['.d fell from 2 to -1 entries'], ['.d fell from 2 to -1 entries'])).toEqual(['.d fell from 2 to -1 entries'])
    })
    // The check of wave 11d (D1): K1 closed the lock-file case for the census and left it open for the deep count, where
    // a one-file entry gone is a 100 % fall and a RESULT: FAIL.
    it('deepCountOf leaves out a transient top-level name too, so a lock or temp file gone is no fall; a real one-file dot-entry gone still is', () => {
      const h = temp('cynco-acc-w11d-deep-')
      writeFileSync(join(h, '.gitconfig.lock'), 'x')
      mkdirSync(join(h, '.x.tmp'))
      writeFileSync(join(h, '.x.tmp', 'a'), 'xx')
      writeFileSync(join(h, '.real'), 'xxx')
      mkdirSync(join(h, '.dir'))
      // Below a dot-folder every file counts, whatever its name: the 2 % allowance is for those.
      writeFileSync(join(h, '.dir', 'a.lock'), 'x')
      writeFileSync(join(h, '.dir', 'b'), 'xx')
      const d0 = deepCountOf(h)
      expect(d0.map(e => [e.name, e.files, e.bytes])).toEqual([['.dir', 2, 3], ['.real', 1, 3]])
      unlinkSync(join(h, '.gitconfig.lock'))
      unlinkSync(join(h, '.x.tmp', 'a'))
      rmdirSync(join(h, '.x.tmp'))
      expect(W.deepFall(d0, deepCountOf(h))).toEqual({ fell: [], lines: [], fail: false })
      unlinkSync(join(h, '.real'))
      const gone = W.deepFall(d0, deepCountOf(h))
      expect(gone.fail).toBe(true)
      expect(gone.fell).toEqual(['.real (files 1 -> 0, bytes 3 -> 0)'])
    })
    it('both callers read through censusOf and censusLoss: the box (c0, censusNow) and the fake stage\'s reading of the real profile (census0)', () => {
      const box = fnSource('async function realBox(')
      expect(box).toContain('const c0 = censusOf(home)')
      expect(box).toContain('const first = censusLoss(c0, censusOf(home))')
      expect(box).toContain('const both = confirmedLoss(first, censusLoss(c0, censusOf(home)))')
      const fakeStage = fnSource('export async function runFakeStage(')
      expect(fakeStage).toContain('try { census0 = censusOf(realHome) } catch (e) {')
      expect(fakeStage).toContain('try { lost = censusLoss(census0, censusOf(realHome)) } catch (e) {')
    })
  })

  describe('K2 positive evidence that the census and the deep count read something (review P5, F3)', () => {
    const d = (name, files) => ({ name, files, bytes: files * 3, unreadable: 0, links: 0 })
    it('censusEvidence: the table', () => {
      need('censusEvidence')
      expect(W.censusEvidence({ c0: ['.a\tdir\t1', '.b\tfile\t0'], d0: [d('.a', 3), d('.b', 1)], home: 'C:\\H', ms: 1234 }))
        .toEqual({ ok: true, line: 'census C0: 2 top-level dot-entries of C:\\H; deep count D0: 2 entries, 4 files (1.2 s)', abort: null })
      const CENSUS = 'ABORT: the census read no dot-entry in C:\\H: neither could show a loss. No probe or attack was run.'
      const DEEP = 'ABORT: the deep count read no file below the dot-entries of C:\\H: it could show no loss. No probe or attack was run.'
      expect(W.censusEvidence({ c0: [], d0: [], home: 'C:\\H', ms: 20 }))
        .toEqual({ ok: false, line: 'census C0: 0 top-level dot-entries of C:\\H; deep count D0: 0 entries, 0 files (0.0 s)', abort: CENSUS })
      expect(W.censusEvidence({ c0: ['.a\tdir\t0'], d0: [d('.a', 0)], home: 'C:\\H', ms: 8800 }))
        .toEqual({ ok: false, line: 'census C0: 1 top-level dot-entries of C:\\H; deep count D0: 1 entries, 0 files (8.8 s)', abort: DEEP })
      // No reading at all is no evidence either; the census is asked first.
      for (const [c0, d0, want] of [[undefined, [d('.a', 1)], CENSUS], [null, null, CENSUS], [['.a\tdir\t1'], undefined, DEEP], [['.a\tdir\t1'], [{ name: '.a' }], DEEP]]) {
        const r = W.censusEvidence({ c0, d0, home: 'C:\\H', ms: 1 })
        expect([r.ok, r.abort], JSON.stringify([c0, d0])).toEqual([false, want])
      }
    })
    it('realBox prints the line right after the two readings, and stops before any probe when it is not ok', () => {
      const src = fnSource('async function realBox(')
      expect(src).toMatch(/^ {4}const t5 = performance\.now\(\)\n {4}const c0 = censusOf\(home\)\n {4}const d0 = deepCountOf\(home\)\n {4}const ce = censusEvidence\(\{ c0, d0, home, ms: performance\.now\(\) - t5 \}\)\n {4}say\(`\$\{TAG\} \$\{ce\.line\}`\)\n {4}if \(!ce\.ok\) \{ say\(`\$\{TAG\} \$\{ce\.abort\}`\); return \{ code: 1 \} \}$/m)
      const stop = src.indexOf('if (!ce.ok) {')
      for (const later of ["seedDecoys(ctx, 'dot')", 'new X.ToolExecutor(', 'viaToolExec(', 'const facts = await containmentFacts(', 'cynco-containment-probe-']) {
        expect(stop, later).toBeLessThan(src.indexOf(later))
      }
      // Inside the try block, so that the finally block settles and releases.
      expect(stop).toBeGreaterThan(src.indexOf('  try {\n    // G4 step 3.'))
      expect((src.match(/censusEvidence\(/g) ?? []).length).toBe(1)
    })
  })

  describe('K3 what a planted hook that was not refused would leave (review F4)', () => {
    it('leftovers names the hook by its literal path, which is the one the catalog\'s Write plant targets', () => {
      const src = fnSource('async function realBox(')
      expect(src).toMatch(/^ {4}const leftovers = \[join\(home, TARGET_DOT_FOLDER, `cynco-acceptance-\$\{nonce\}\.txt`\), join\(ctx\.sandbox\.scratch, `out-\$\{nonce\}`\), join\(mission, '\.git', 'hooks', 'post-checkout'\)\]$/m)
      // Removed only when this call made it, by literal path (the existing rule).
      expect(src).toContain('if (madeByThisCall({ existedBefore: before.get(m), existsNow: now })) { const why = removeOne(m);')
      expect(src).toContain('const before = new Map(leftovers.map(m => [m, exists(m)]))')
      // The catalog, as realBox builds its `p` (cwd: the box's mission folder): every Write the real box hands over writes a
      // path that list names, the planted hook among them.
      const p = fakeP(resolve('acc-w11d-root-never-made'))
      const leftoversOf = (q) => [join(q.home, TARGET_DOT_FOLDER, `cynco-acceptance-${q.nonce}.txt`), join(q.scratch, `out-${q.nonce}`), join(q.cwd, '.git', 'hooks', 'post-checkout')]
      const real = attacks({ shell: 'powershell', python: 'python', gitBash: null }).flatMap(a => a.variants(p).map(v => ({ id: a.id, v })))
        .filter(({ v }) => v.stages.includes('real') && v.platforms.includes('win32') && !v.fullStackOnly && v.call.tool === 'Write')
      expect(real.map(({ id }) => id).sort()).toEqual(['left-behind', 'write-dot-folder'])
      for (const { id, v } of real) expect(leftoversOf(p), `${id} ${v.label}`).toContain(v.call.input.file_path)
      const plant = real.find(({ id }) => id === 'left-behind').v
      expect(plant.targets).toEqual([join(p.cwd, '.git', 'hooks', 'post-checkout')])
    })
  })

  describe('K4 the real stage names a home it cannot list (review P8)', () => {
    it('homeListingRefusal: the table', () => {
      need('homeListingRefusal')
      expect(W.homeListingRefusal({ home: 'C:\\Users\\o', fault: null })).toBeNull()
      expect(W.homeListingRefusal({ home: 'C:\\Users\\o' })).toBeNull()
      expect(W.homeListingRefusal({ home: 'C:\\nowhere\\fake', fault: 'ENOENT' }))
        .toBe('[acceptance] REFUSED: the top level of the home C:\\nowhere\\fake could not be listed (ENOENT): its Low labels cannot be checked — nothing was run')
      expect(W.homeListingRefusal({ home: 'C:\\Users\\o', fault: 'EPERM' })).toMatch(/^\[acceptance\] REFUSED: the top level of the home C:\\Users\\o could not be listed \(EPERM\): /)
      // The code a listing of a folder that does not exist gives, as the stage reads it.
      let code = null
      try { readdirSync(join(temp('cynco-acc-w11d-nohome-'), 'nowhere')) } catch (e) { code = e?.code ?? e?.message ?? String(e) }
      expect(code).toBe('ENOENT')
    })
    it('runRealStage catches the listing, asks realStageRefusal first, and then refuses by name, before the evidence file', () => {
      const real = fnSource('export async function runRealStage(')
      expect(real).not.toMatch(/for \(const n of readdirSync\(home\)/)
      expect(wholeLines(real, '    try { names = readdirSync(home) } catch (e) { listFault = e?.code ?? e?.message ?? String(e) }')).toBe(1)
      expect(wholeLines(real, '    for (const n of names.filter(x => x.startsWith(\'.\'))) if (explicitLowLabelled(join(home, n))) lowList.push(join(home, n))')).toBe(1)
      expect(wholeLines(real, '  if (listWhy) { say(listWhy); return { code: 2 } }')).toBe(1)
      const at = (s) => { const i = real.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i }
      const order = [at('let listFault = null'), at('try { names = readdirSync(home) }'), at('if (why) { say(why); return { code: 2 } }'),
        at('const listWhy = homeListingRefusal({ home, fault: listFault })'), at('if (listWhy) { say(listWhy); return { code: 2 } }'), at('evidenceFd = openSync(')]
      for (let i = 1; i < order.length; i++) expect(order[i - 1], `step ${i}`).toBeLessThan(order[i])
    })
  })

  describe('K5 pins that a suffix cannot walk around (review P2, P3, P4, P7)', () => {
    it('P2: the control\'s "made" is read from its file before the file is removed, and nothing writes it before the two readings', () => {
      const src = fnSource('async function realBox(')
      const after = src.slice(src.indexOf('const after = async ('), src.indexOf('const fire = async ('))
      expect(after).toMatch(/^ {6}const made = control \? exists\(control\.file\) : null$/m)
      const decl = after.indexOf('const made = control ? exists(control.file) : null\n')
      expect(decl).toBeGreaterThan(-1)
      expect(decl).toBeLessThan(after.indexOf('const gone = removeOne(control.file)'))
      expect((after.match(/\b(?:const|let|var) made\b/g) ?? []).length).toBe(1)
      const reads = [...after.matchAll(/afterReading\(\{ control: control !== null, verdict, made, changed: cmp\.changed, lost/g)].map(m => m.index)
      expect(reads).toHaveLength(2)
      expect(reads[0]).toBeGreaterThan(decl)
      const between = after.slice(after.indexOf('\n', decl), reads[1])
      expect(between, 'made written to before the readings').not.toMatch(/\bmade\b\s*(?:\.\s*\w+\s*|\[[^\]]*\]\s*)?(?:[-+*/|&?]?=(?!=)|\+\+|--)/)
    })
    it('P3: the end of the box, each statement a whole line, once, in order', () => {
      const src = fnSource('async function realBox(')
      const end = src.slice(src.indexOf('// G7: the end.'))
      const want = [
        '    const lost = await censusNow()',
        '    const deepFail = deep.fail',
        '    const av = auditVerdict({ v: A.verifyAuditFiles(files), runId, files })',
        '    const end = settleVerdict({ settle, lost, deepFail, audit: av, where })',
        '    if (!end.pass) { say(end.line); return { code: 1 } }',
      ]
      let from = -1
      for (const l of want) {
        expect(wholeLines(src, l), l).toBe(1)
        const i = end.indexOf(`\n${l}\n`)
        expect(i, l).toBeGreaterThan(from)
        from = i
      }
    })
    it('P4: the six tripwire checks, each a whole statement: five end the box with code 1, the one in after() answers false', () => {
      const src = fnSource('async function realBox(')
      const after = src.slice(src.indexOf('const after = async ('), src.indexOf('const fire = async ('))
      expect((src.match(/^ *if \(await trip\.abort\(\)\) return \{ code: 1 \}$/gm) ?? []).length).toBe(5)
      expect((after.match(/^ *if \(await trip\.abort\(\)\) return false$/gm) ?? []).length).toBe(1)
      // Every check there is (a comment of realBox names trip.abort() without await).
      expect((src.match(/await trip\.abort\(\)/g) ?? []).length).toBe(6)
    })
    // The check of wave 11d (D4): three more statements a suffix could walk around, each a whole line, once.
    it('D4: the deep count\'s reading, the census\'s "no loss" return and the control\'s call and stop are whole lines', () => {
      const src = fnSource('async function realBox(')
      for (const l of [
        '    let deep = deepFall(d0, deepCountOf(home))',
        '      if (first.length === 0) return []',
        '    const controlOk = await fire({ id: \'control\', title: \'the control\' }, controlV, { file: controlFile })',
        '    if (!controlOk) return { code: 1 }',
      ]) expect(wholeLines(src, l), l).toBe(1)
    })
    it('P7: the comment at the settle names the case that pins it', () => {
      const src = fnSource('async function realBox(')
      expect(src).toContain('// Wave 11c, H3: settleVerdict reads this result itself, unchanged (a text pin in T2.39 (H3) holds the statement whole).')
      expect(src).not.toMatch(/text pin in T2\.38 holds the statement whole/)
    })
  })

  describe('K6 systemHome under Bun, measured (review P1)', () => {
    if (!WIN || !bunPath) console.log(`[test] T2.40 K6 is skipped: ${!WIN ? 'not Windows (systemHome asks userenv.dll on Windows only)' : 'bun is not on the PATH'}`)
    it.skipIf(!WIN || !bunPath)('under Bun with USERPROFILE naming a folder that does not exist, systemHome answers the real home while os.homedir() answers the fake one (the premise: if Bun stops following USERPROFILE this case says so), and the guard refuses the two', () => {
      const dir = temp('cynco-acc-w11d-home-')
      // The fake home lies in this case's own temp folder (Bun makes its transpiler cache below the home it is given).
      const FAKE = join(dir, 'nowhere', 'fake')
      expect(existsSync(FAKE)).toBe(false)
      const mod = join(dir, 'probe.mjs')
      const runnerUrl = pathToFileURL(resolve('scripts', 'cynco-containment-acceptance.mjs')).href
      writeFileSync(mod, [
        "import os from 'node:os'",
        `const { systemHome } = await import(${JSON.stringify(runnerUrl)})`,
        "console.log('HOMES ' + JSON.stringify({ systemHome: await systemHome(), homedir: os.homedir(), userInfo: os.userInfo().homedir }))",
        '',
      ].join('\n'))
      const env = { ...process.env, USERPROFILE: FAKE, HOMEDRIVE: FAKE.slice(0, 2), HOMEPATH: FAKE.slice(2) }
      delete env[REAL_PROFILE_VAR]
      const r = spawnSync(bunPath, [mod], { encoding: 'utf-8', timeout: 60_000, windowsHide: true, env })
      expect(r.error, String(r.error)).toBeUndefined()
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0)
      const line = String(r.stdout).split(/\r?\n/).find(l => l.startsWith('HOMES '))
      expect(line, `${r.stdout}\n${r.stderr}`).toBeTruthy()
      const got = JSON.parse(line.slice('HOMES '.length))
      console.log(`[test] T2.40 K6 under Bun with USERPROFILE=${FAKE}: ${JSON.stringify(got)}`)
      const realHome = userInfo().homedir
      expect(got.systemHome, 'systemHome under Bun').toBe(realHome)
      expect(got.systemHome).not.toBe(FAKE)
      expect(got.homedir, 'the premise: Bun\'s os.homedir() follows USERPROFILE').toBe(FAKE)
      expect(W.homesRefusal({ env: FAKE, system: got.systemHome })).toBe(`[acceptance] REFUSED: the home folder is read two ways and they disagree (${FAKE} vs ${realHome}) — nothing was run`)
    }, 90_000)
    it('systemHome\'s Bun branch answers null when the system call fails, and never falls through to os.userInfo()', () => {
      const src = fnSource('export async function systemHome(')
      expect(src).toMatch(/^ {2}if \(WIN && typeof globalThis\.Bun\?\.version === 'string'\) \{$/m)
      expect(src).toMatch(/^ {4}\} catch \(e\) \{\n {6}return null\n {4}\}\n {2}\}\n {2}try \{\n {4}return os\.userInfo\(\)\.homedir$/m)
      // The check of wave 11d (D3): the call's own failure answers null on its line, whole; os.userInfo() is asked once, off Bun.
      expect(wholeLines(src, '        if (!lib.symbols.GetUserProfileDirectoryW(-4n, buf, size) || size[0] < 2 || size[0] > 1024) return null')).toBe(1)
      expect((src.match(/os\.userInfo\(\)/g) ?? []).length).toBe(1)
    })
  })
})

describe.skipIf(!bunPath)('T3 the fake-home stage under Bun, no live fire', () => {
  let report = null
  let run = null
  let root = null
  let skipWhy = null
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cynco-acc-fake-'))
    run = spawnSync(bunPath, ['scripts/cynco-containment-acceptance.mjs', '--stage', 'fake', '--root', root, '--no-live-fire', '--json'],
      { encoding: 'utf-8', timeout: 240_000, windowsHide: true })
    const last = String(run.stdout ?? '').split(/\r?\n/).filter(l => l.startsWith('REPORT ')).pop()
    report = last ? JSON.parse(last.slice('REPORT '.length)) : null
    // Rule F1's two refusals that name this shell's level: the suite then skips, it does not fail.
    const refused = String(run.stdout ?? '').split(/\r?\n/).find(l => l.startsWith('[acceptance] REFUSED:'))
    if (run.status === 2 && refused && /at low integrity \(it is a contained child\)|this shell is elevated|integrity level of this shell could not be read/.test(refused)) skipWhy = refused
  }, 300_000)
  afterAll(() => {
    if (run?.error?.code === 'ETIMEDOUT' || run?.signal) {
      // The stage was killed: what it started may still be writing and labelling inside the root.
      console.log(`[test] T3 timed out; the root ${root} is left in place. Read it with bun scripts/cynco-sandbox.mjs status before removing it.`)
      return
    }
    if (report) {
      for (const l of report.links ?? []) {
        try { rmdirSync(l) } catch { try { unlinkSync(l) } catch (e) { console.log(`[test] the link ${l} could not be removed: ${e.message}`) } }
        expect(gone(l), `the link ${l} is still there`).toBe(true)
      }
    }
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const need = (ctx) => {
    if (skipWhy) ctx.skip(skipWhy)
    if (!report) ctx.skip('no report: the first case says why')
    return report
  }

  it(`runs to its result line (${WIN ? 'Windows: with the low-integrity layer' : 'not Windows: the path check and the overlay under Bun with a real shell, not the kernel layer'})`, (ctx) => {
    if (skipWhy) ctx.skip(skipWhy)
    expect(run.error, String(run.error)).toBeUndefined()
    expect(run.status, `${String(run.stdout).slice(-3000)}\n${run.stderr}`).toBe(0)
    expect(report).not.toBeNull()
    expect(report.liveFire).toBe(false)
    // Measured by the orchestrator from the real home's census and the real stage's presence roots (AppData's four
    // application roots and the home's whole top level among them), before and after (read only).
    expect(report.realProfileLoss, 'no top-level dot-entry, top-level folder or application folder of the real profile lost or emptied (the presence rule; a write or a deeper change is not measured)').toBe(false)
    expect(String(run.stdout)).toMatch(/\[acceptance\] the real profile's presence roots \(.*AppData.*\), by the PRESENCE rule of the real stage: no loss/)
    expect(report.commit?.sha, 'the report names the commit it ran on').toMatch(/^[0-9a-f]{40}$|^unknown$/)
    expect(report.pass).toBe(true)
    expect(report.entries.filter(e => e.outcome === 'FAILED' || e.outcome === 'UNSAFE')).toEqual([])
  })

  it('every variant of the catalog was handed to the full stack and refused before it ran, with one refused record and no start', (ctx) => {
    const rep = need(ctx)
    expect(rep.tools, 'the report names the shell, python and Git Bash the catalog was built with').toBeTruthy()
    const host = WIN ? 'win32' : 'posix'
    const want = attacks(rep.tools).flatMap(a => a.variants(fakeP(rep.root)).filter(v => v.platforms.includes(host)).map(v => ({ id: a.id, label: v.label, form: v.form, variant: v.variant })))
    expect(want.length).toBeGreaterThan(20)
    const run3 = rep.entries.filter(e => e.run === 3)
    const missing = []
    for (const w of want) {
      if (w.form === 'run-folders') {
        // R15 (a): an ordinary thing a run may do; the full stack's answer is the path check's, pinned in
        // engine/__tests__/tools/containmentAttacks.test.ts ("the junction from the scratch folder to the mission folder").
        const e = run3.find(x => x.id === w.id && x.variant === w.label && x.form === w.form)
        expect(e?.outcome, `${w.id} ${w.label}: ${e?.detail}`).toBe(RUN_FOLDERS_ANSWER)
        if (WIN && e?.outcome === 'allowed') {
          // T7, the runner's side: a contained child (low integrity, under Bun) made this junction, so it is the
          // \??\Global\ form lstat cannot see; the runner told it by the listing, read where it lands and removed it.
          expect(e.detail, e.detail).toMatch(/repo-[0-9a-f]+ -> .*mission\b.*\(removed\)$/)
          expect(rep.links.filter(l => /repo-[0-9a-f]+$/.test(l)), 'the run 3 junction was left behind').toEqual([])
        }
        continue
      }
      const refused = run3.find(e => e.id === w.id && e.variant === w.label && e.form === w.form && e.outcome === 'refused')
      if (refused) {
        expect(refused.audit, `${w.id} ${w.label}`).toMatchObject({ start: 0, refused: 1, end: 0, layer: 'protected path' })
        expect(refused.decoys, `${w.id} ${w.label}`).toBe('intact')
        continue
      }
      // The one exception: a Git Bash mission variant whose twin could not start is never handed over.
      const twin = run3.find(e => e.id === w.id && e.variant === w.label && e.form === 'honest twin')
      if (w.variant === 'git-bash' && w.form === 'mission' && twin?.outcome === 'twin did not resolve') continue
      missing.push(`${w.id} ${w.label} ${w.form}`)
    }
    expect(missing, 'catalog variants with no refused entry in run 3').toEqual([])
    expect(run3.filter(e => e.id === 'protected-folder' && e.outcome === 'refused').map(e => e.variant)).toHaveLength(7)
    const run5 = rep.entries.filter(e => e.run === 5 && e.form === 'literal' && e.outcome === 'refused').map(e => e.variant).sort()
    expect(run5).toEqual(['Write to authoring/other', 'Write to heldout/c1'])
    if (WIN) {
      const denied = rep.entries.filter(e => e.run === 2 && e.form === 'kernel' && e.outcome === 'denied').map(e => e.variant).sort()
      expect(denied).toEqual(['create in c1', 'create in other'])
    }
    expect(rep.leftBehind.map(x => x.surface)).toEqual(LEFT_BEHIND.surfaces)
  })

  it('every honest call was allowed, the four lines of canary c7 through the full stack included', (ctx) => {
    const rep = need(ctx)
    const full = rep.entries.filter(e => [3, 4, 5].includes(e.run))
    for (const e of full.filter(x => x.form === 'honest')) {
      if (e.variant.startsWith('the check command')) continue
      // pytest may be installed only in the real user site, which the fake home does not read.
      if (e.variant === 'c7 pytest' && e.outcome === 'not proven') { expect(e.detail).toMatch(/^\(b\) not proven: no module named pytest/); continue }
      expect(e.outcome, `${e.id} ${e.variant}: ${e.detail}`).toBe('allowed')
    }
    expect(full.filter(x => x.run === 3 && /^c7 /.test(x.variant)).map(x => x.variant).sort())
      .toEqual(['c7 a write under the temp folder', 'c7 edit, add and commit', 'c7 pytest', 'c7 the user site'])
    for (const e of full.filter(x => x.form === 'honest twin')) {
      expect(['allowed', 'twin did not resolve'], `${e.id} ${e.variant}: ${e.detail}`).toContain(e.outcome)
      if (e.outcome !== 'allowed') expect(e.variant).toBe('git-bash')
    }
  })

  it('every resolved twin printed at least one path, all inside a sandbox home', (ctx) => {
    const rep = need(ctx)
    const dry = rep.entries.filter(e => e.form === 'dry' && e.outcome === 'resolved')
    expect(dry.length).toBeGreaterThan(3)
    // RS-1: what the ninth attack's Git Bash twin answered in each run (resolved, or Git Bash did not start at low integrity).
    for (const e of rep.entries.filter(x => x.id === 'appdata-walk' && x.variant === 'git-bash')) console.log(`[test] run ${e.run} appdata-walk git-bash ${e.form}: ${e.outcome}${e.detail ? ` (${String(e.detail).slice(0, 160)})` : ''}`)
    const sandboxRoot = join(rep.root, 'sandbox-root')
    for (const e of dry) {
      expect(e.targets.length, `${e.id} ${e.variant}`).toBeGreaterThanOrEqual(1)
      for (const t of e.targets) {
        expect(insideRoot(sandboxRoot, t), `${e.id} ${e.variant}: ${t}`).toBe(true)
        expect(t.toLowerCase().slice(sandboxRoot.length).split(/[\\/]/)[2], `${e.id} ${e.variant}: ${t} is not in a sandbox home`).toBe('home')
      }
    }
  })

  it('the daemon-task run has its four calls and its open record; the authoring check ran, or is the owner\'s open decision', (ctx) => {
    const rep = need(ctx)
    const daemon = rep.entries.filter(e => e.run === 4 && ['mission', 'literal', 'honest'].includes(e.form))
    expect(daemon.length).toBe(4)
    expect(rep.entries.find(e => e.run === 4 && e.form === 'audit')?.outcome).toBe('passed')
    for (const n of [2, 5]) {
      const check = rep.entries.find(e => e.run === n && String(e.variant).startsWith('the check command'))
      expect(check, `run ${n}`).toBeTruthy()
      if (check.outcome === 'not proven') {
        // Measured on Bun 1.3.13: Bun at low integrity cannot load a module from a folder not labelled low.
        expect(WIN).toBe(true)
        expect(check.detail).toMatch(/open owner decision/)
      } else {
        expect(['passed', 'allowed']).toContain(check.outcome)
        expect(check.detail).toMatch(/exit 1/)
      }
    }
  })

  it('left-behind code: no surface that fired in the control fired under the harness environment; the hooks and the conftest were armed', (ctx) => {
    const rep = need(ctx)
    const lb = Object.fromEntries(rep.leftBehind.map(x => [x.surface, x]))
    for (const x of rep.leftBehind) if (x.armed === 'armed') expect(x.fired, x.surface).toBe(false)
    for (const s of ['post-checkout', 'pre-commit', 'conftest']) expect(lb[s].armed, s).toBe('armed')
  })

  it('wave 10c (C2, C3, C9): the canaries, run 2\'s two kernel entries and the nine left-behind entries, as printed; each armed surface neutralised, each other one "did not fire in the control either"', (ctx) => {
    const rep = need(ctx)
    const out = String(run.stdout).split(/\r?\n/)
    // Wave 10d: the idle answers of runs 1 and 2 (F3), each proof git line's end beside the control's (F2), run 3's
    // run-folders entry (F9) and the RESULT line are printed too, so that the evidence of an honest run can be read.
    const shownLine = (x) => /^\[acceptance\] canary (c\d|idle)/.test(x) || /^\[acceptance\] run 2 authoring: (authoring create in |canary idle )/.test(x)
      || /^\[acceptance\] run 1 mission: left-behind /.test(x) || /^\[acceptance\] left-behind: /.test(x) || /^\[acceptance\] run 3 mission: .* run-folders: /.test(x)
      || /^\[acceptance\] RESULT: /.test(x)
    for (const l of out.filter(shownLine)) console.log(`[test] T3 ${l}`)
    const lb = Object.fromEntries(rep.leftBehind.map(x => [x.surface, x]))
    const entries = rep.entries.filter(e => e.run === 1 && e.id === 'left-behind')
    expect(entries.map(e => e.variant)).toEqual(LEFT_BEHIND.surfaces)
    for (const e of entries) {
      if (lb[e.variant].armed === 'armed') expect(`${e.outcome} ${e.detail ?? ''}`, e.variant).toBe('neutralised ')
      else expect([e.outcome, e.detail], e.variant).toEqual(['not proven', 'it did not fire in the control either'])
    }
    if (WIN) {
      for (const v of ['create in other', 'create in c1']) {
        const e = rep.entries.find(x => x.run === 2 && x.variant === v)
        expect(e?.outcome, `${v}: ${e?.detail}`).toBe('denied')
        // C2: the entry carries the denial in the child's own words; F11: read with the lines joined, and it says so.
        expect(denialWords(e.detail ?? ''), v).not.toBeNull()
        expect(e.detail, v).toMatch(/^lines joined: /)
      }
      // F3: runs 1 and 2 read their idle answer first, and the good case shows it ran.
      expect(rep.canary.idle).toMatch(/^passed \(preflight: a command that touches nothing answered with its marker alone/)
      expect(rep.entries.filter(x => x.run === 2 && x.id === 'canary' && x.variant === 'idle').map(x => x.outcome)).toEqual(['passed'])
      // F1: the conftest surface read neutralised on its witness in the sandbox home.
      expect(rep.innerRuns.find(r => r.run === 1)?.notes ?? []).toContain('the conftest witness is in the sandbox home (allowed)')
    }
    // F2: every proof git line's end is printed beside the control's.
    expect(out.filter(x => /^\[acceptance\] left-behind: git .*: the control's line .*, the proof's /.test(x))).toHaveLength(LEFT_BEHIND.harnessGit.length)
  })

  it('R11: the mission repository left in the root is disarmed, and the closing line says so', (ctx) => {
    const rep = need(ctx)
    const mission = join(rep.root, 'mission')
    const cfg = readFileSync(join(mission, '.git', 'config'), 'utf8')
    for (const k of ['fsmonitor', 'pager', 'external', 'textconv', 'clean', 'smudge']) expect(cfg, `.git/config still holds ${k}`).not.toMatch(new RegExp(`^\\s*${k}\\s*=`, 'm'))
    for (const rel of disarmPlan({ home: join(rep.root, 'profile', 'Users', 'tester'), cwd: mission, nonce: '00000000' }).files.map(f => f.slice(mission.length + 1))) {
      expect(existsSync(join(mission, rel)), `${rel} is still there`).toBe(false)
    }
    expect(String(run.stdout)).toMatch(/the mission repository .* was disarmed/)
  })

  it('R12: the harness wrote no Bun cache into the fake home, and every literal shell form\'s targets still exist', (ctx) => {
    const rep = need(ctx)
    const home = join(rep.root, 'profile', 'Users', 'tester')
    expect(existsSync(join(home, '.bun')), 'the fake home holds a .bun folder').toBe(false)
    const p = { ...fakeP(rep.root), dotEntries: readdirSync(home).filter(n => n.startsWith('.')) }
    const host = WIN ? 'win32' : 'posix'
    for (const a of attacks(rep.tools)) {
      for (const v of a.variants(p).filter(x => x.platforms.includes(host) && x.form === 'literal' && x.call.tool === 'Bash' && !x.makes)) {
        // A form's own new file is not a target that must exist; everything it would delete is.
        for (const t of (v.targets ?? []).filter(x => !(v.creates ?? []).includes(x))) expect(existsSync(t), `${a.id} ${v.label}: ${t}`).toBe(true)
      }
    }
  })

  it('A3: after the stage the fake AppData holds what buildFakeProfile put there, and what else is there is named (the writers of FAKE_HOME_EXCLUDE among it)', (ctx) => {
    const rep = need(ctx)
    const home = join(rep.root, 'profile', 'Users', 'tester')
    // Files AND folders (RH8-6): the runner's comparisons record a folder as an entry of its own ('d'), so a new empty
    // folder changes "the fake home" as a new file does.
    const files = [], folders = []
    const walk = (d, rel) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) { folders.push(r); walk(join(d, e.name), r) } else files.push(r)
      }
    }
    walk(join(home, 'AppData'), 'AppData')
    for (const rel of FAKE_APPDATA_FILES) expect(files, `${rel} is gone`).toContain(rel)
    const extra = files.filter(f => !FAKE_APPDATA_FILES.includes(f))
    console.log(`[test] A3: files in the fake AppData after the stage that buildFakeProfile did not put there: ${extra.length ? extra.join(', ') : 'none'}`)
    // Each is written before the comparisons of runs 3 to 7 begin (run 1), or is excluded by an exact sub-path.
    const USERPKG = /^AppData\/Roaming\/Python\/Python\d+\/site-packages\/cynco_acceptance_userpkg\.py$/
    // Wave 11: the box rehearsal (inner run 9) makes its mission folder in the fake temp folder (realBox's
    // mkdtempSync(join(os.tmpdir(), 'cynco-acceptance-real-'))) and leaves it there, as the real stage leaves its own in the
    // real temp folder. Accounted for by its exact path, which the report names (boxFolder), never by a pattern (RH8-6).
    const boxRel = rep.boxFolder ? relativeTo(home, rep.boxFolder) : null
    if (WIN) expect(boxRel, 'the report names the box rehearsal\'s folder').toMatch(/^AppData\/Local\/Temp\/cynco-acceptance-real-[^/]+$/)
    const known = (f) => FAKE_HOME_EXCLUDE.some(x => f === x || f.startsWith(`${x}/`)) || USERPKG.test(f) || (boxRel !== null && (f === boxRel || f.startsWith(`${boxRel}/`)))
    expect(extra.filter(f => !known(f)), 'files in the fake AppData that nothing in the runner accounts for').toEqual([])
    // A folder is accounted for when buildFakeProfile made it (a parent of one of its files, Temp, Roaming\Python),
    // when it holds an excluded path or the user-site file, or when an excluded path holds it.
    const ancestors = (rel) => rel.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))
    const made = new Set([...FAKE_APPDATA_FILES.flatMap(ancestors), 'AppData/Local/Temp', 'AppData/Roaming/Python'])
    const holdsKnown = new Set([...FAKE_HOME_EXCLUDE, ...files.filter(f => USERPKG.test(f))].flatMap(ancestors))
    const extraFolders = folders.filter(d => !made.has(d))
    console.log(`[test] A3: folders in the fake AppData after the stage that buildFakeProfile did not make: ${extraFolders.length ? extraFolders.join(', ') : 'none'}`)
    expect(extraFolders.filter(d => !holdsKnown.has(d) && !known(d)), 'folders in the fake AppData that nothing in the runner accounts for').toEqual([])
  })

  it('R3, R14: each link is named once; every not-proven entry is in the accepted table and printed on a line of its own, then a tally', (ctx) => {
    const rep = need(ctx)
    const fold = (p) => (WIN ? p.toLowerCase() : p)
    expect(new Set(rep.links.map(fold)).size).toBe(rep.links.length)
    const np = rep.entries.filter(e => ['not proven', 'twin did not resolve', 'did not act', 'did not start (msys)'].includes(e.outcome))
    for (const e of np) expect(acceptedReasonOf(e), `run ${e.run} ${e.id} ${e.variant} ${e.form}: ${e.detail}`).not.toBeNull()
    const out = String(run.stdout)
    expect(out.match(/\[acceptance\] not proven: run \d/g) ?? []).toHaveLength(np.length)
    expect(out).toMatch(/\[acceptance\] entries by outcome word: /)
  })

  it.skipIf(!WIN)('wave 11: the box rehearsal (inner run 9) ran realBox against the fake home and passed, and its evidence shows each reading', async (ctx) => {
    const rep = need(ctx)
    const out = String(run.stdout).split(/\r?\n/)
    const start = out.indexOf('[acceptance] inner run 9: --inner box --phase rehearsal')
    expect(start, 'the orchestrator never started the box rehearsal').toBeGreaterThan(-1)
    const end = out.findIndex((l, i) => i > start && l.startsWith('[acceptance] run 9 rehearsal: box realBox rehearsal: '))
    expect(end, 'the box rehearsal printed no entry').toBeGreaterThan(start)
    const lines = out.slice(start, end + 1)
    const shown = (l) => /^\[acceptance\] (preflight|attack |after: |settle|audit|RESULT|not proven|reachable|the registry probe|the NOT PROVEN|rehearsal|census|deep count|honest work|run 9 |control|tripwire)/.test(l)
      || / refused before it ran by the protected path layer; /.test(l) || /manifest unchanged after /.test(l)
    for (const l of lines.filter(shown)) console.log(`[test] T3 run 9 ${l}`)
    // One entry, passed, whose detail is the box's own RESULT line; the calls add up.
    const mine = rep.entries.filter(x => x.run === 9)
    expect(mine.map(x => [x.id, x.variant, x.form, x.outcome]), JSON.stringify(mine)).toEqual([['box', 'realBox', 'rehearsal', 'passed']])
    expect(rep.innerRuns.map(r => r.run)).toContain(9)
    const m = /^RESULT: PASS \(box rehearsal, fake home\): 4 create probes denied, (\d+) calls refused before running and (\d+) accepted twins? that did not resolve, of (\d+) calls taken up/.exec(mine[0].detail)
    expect(m, mine[0].detail).not.toBeNull()
    const [refused, twins, calls] = m.slice(1).map(Number)
    expect(refused + twins).toBe(calls)
    expect(refused).toBeGreaterThan(0)
    expect(lines).toContain(`[acceptance] ${mine[0].detail}`)
    // The idle answer first, then the four create probes, each read from the denial in the child's own words.
    expect(lines.some(l => l.startsWith('[acceptance] preflight: a command that touches nothing answered with its marker alone'))).toBe(true)
    const home = join(rep.root, 'profile', 'Users', 'tester')
    const pre = lines.filter(l => l.startsWith('[acceptance] preflight: a contained child was denied creating '))
    expect(pre, pre.join('\n')).toHaveLength(4)
    for (const [i, folder] of [home, join(rep.root, 'guard'), join(rep.root, 'audit'), join(rep.root, 'models')].entries()) {
      expect(pre[i].startsWith(`[acceptance] preflight: a contained child was denied creating ${join(folder, 'cynco-containment-probe-')}`), pre[i]).toBe(true)
      expect(pre[i]).toMatch(/ \(lines joined: .+\)$/)
      expect(denialWords(pre[i].slice(pre[i].indexOf('(lines joined: '))), pre[i]).not.toBeNull()
    }
    // Wave 11b, G8: the rehearsal names the machine's own folders it judged its root against; the real home is the one the
    // system reports under Bun (userenv.dll), never the repointed USERPROFILE (this suite's process is not repointed).
    const reh = lines.filter(l => l.startsWith(REHEARSAL_FOLDERS_LINE))
    expect(reh, lines.join('\n')).toHaveLength(1)
    // Changed on purpose in wave 11c (H4): the machine's folders are the fake stage's own (this suite's process is its
    // parent, so engine/paths here answers what the fake stage saw), handed to run 9, with the code defaults after them.
    const P = await import('../../engine/paths.js')
    console.log(`[test] T3 run 9 machine folders: ${reh[0].slice(reh[0].indexOf(MACHINE_FOLDERS_MARK))}`)
    expect(reh[0]).toContain(`${MACHINE_FOLDERS_MARK}the real home ${homedir()}, the guard folder ${P.guardDir()}, `)
    expect(reh[0]).toContain(`, the models folder ${P.modelsDir()}`)
    // Wave 11b, G6: the engine's in-run presence tripwire is on over the fake home, and its first look found nothing lost.
    const tw = lines.filter(l => /^\[acceptance\] tripwire on: \d+ folder\(s\) under \d+ root\(s\), every 60 s and before a tool call through the executor \(at most once a second\)$/.test(l))
    expect(tw, lines.join('\n')).toHaveLength(1)
    expect(Number(/tripwire on: (\d+) folder/.exec(tw[0])[1])).toBeGreaterThan(0)
    const roots = lines.find(l => l.startsWith('[acceptance] tripwire roots: '))
    expect(roots, 'the tripwire roots line').toBeTruthy()
    expect(roots).toContain(`${home} (folders counted, dot-files by name)`)
    expect(lines.filter(l => /^\[acceptance\] tripwire: one look before the first call: nothing lost \(\d+\.\d ms\)$/.test(l))).toHaveLength(1)
    // Wave 11b, G1: the control, before the first attack: one line, read as not refused, its file made and removed, not counted.
    const firstAttack = lines.findIndex(l => /^\[acceptance\] attack \S+ \(/.test(l))
    const ctl = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('[acceptance] control: '))
    expect(ctl, lines.join('\n')).toHaveLength(1)
    expect(ctl[0][1]).toBeLessThan(firstAttack)
    expect(ctl[0][0]).toMatch(/^\[acceptance\] control: a Write of a new file in the mission folder, which the path check allows, handed to the attacks' own path, read as not refused \(was not refused before it ran \(isError false, layer none, audit \{"start":1,"refused":0,"end":1,"layer":null\}, decoys intact\)\); its file was made and removed; the manifest unchanged \(\d+ entries, \d+ ms\)\. It is not counted among the attacks\.$/)
    expect(lines.filter(l => /control/i.test(l) && /ABORT/.test(l))).toEqual([])
    // Each attack handed over: refused by the path check with one refused record and no start or end, then the manifest
    // compared and unchanged, before the next.
    const at = lines.map((l, i) => [l, i]).filter(([l]) => /^\[acceptance\] attack \S+ \(/.test(l)).map(([, i]) => i)
    expect(at.length, 'attacks handed over').toBe(refused)
    for (const [k, i] of at.entries()) {
      const until = k + 1 < at.length ? at[k + 1] : lines.findIndex(l => l.startsWith('[acceptance] settle: '))
      const seg = lines.slice(i, until)
      const refusedLines = seg.map(l => / refused before it ran by the protected path layer; audit (\{.*\})$/.exec(l)).filter(Boolean)
      expect(refusedLines, seg.join('\n')).toHaveLength(1)
      expect(JSON.parse(refusedLines[0][1]), seg.join('\n')).toEqual({ start: 0, refused: 1, end: 0, layer: 'protected path' })
      expect(seg.filter(l => /^\[acceptance\] manifest unchanged after .+ \(\d+ entries, \d+ ms\)$/.test(l)), seg.join('\n')).toHaveLength(1)
    }
    // The settle, the audit of this run, and the steps skipped by name.
    expect(lines).toContain('[acceptance] settle: unchanged')
    expect(lines.filter(l => l.startsWith('[acceptance] audit: 0 gap(s), 0 start(s) without an end, 0 unparsable line(s); files read: '))).toHaveLength(1)
    expect(lines.some(l => l.startsWith("[acceptance] the registry probe: skipped in the rehearsal: HKCU is the real user's hive, which no environment repoints"))).toBe(true)
    for (const name of ['docker version', 'wsl -l -q', 'schtasks /query /fo LIST']) {
      expect(lines).toContain(`[acceptance] reachable from a contained child: ${name}: skipped in the rehearsal: it asks the machine, not the fake home, and the real stage asks it`)
    }
    expect(lines).toContain('[acceptance] the NOT PROVEN block: skipped in the rehearsal: it speaks of the real profile')
    expect(lines.filter(l => /^\[acceptance\] (ABORT|UNSAFE|REFUSED|FAIL)\b/.test(l))).toEqual([])
    // Wave 11d, K7 (review P5): the box's deciding lines, in the shapes the rehearsal prints them (read from a fake stage
    // run's output). The run id, from its own line, ties the audit, the settling compare and the release to this box.
    const runIds = lines.map(l => /^\[acceptance\] run id (acceptance-real-\S+); mission folder /.exec(l)?.[1]).filter(Boolean)
    expect(runIds, lines.join('\n')).toHaveLength(1)
    const runId = runIds[0]
    expect(lines.filter(l => l.startsWith(`[acceptance] rehearsal: the fake models record was taken in ${join(rep.root, 'guard')} `)), 'the fake models record line').toHaveLength(1)
    // K2: the census and the deep count read something, in the fake home.
    const census = lines.map(l => /^\[acceptance\] census C0: (\d+) top-level dot-entries of (.+); deep count D0: (\d+) entries, (\d+) files \(\d+\.\d s\)$/.exec(l)).filter(Boolean)
    expect(census, lines.join('\n')).toHaveLength(1)
    expect(census[0][2]).toBe(home)
    expect(Number(census[0][1]), census[0][0]).toBeGreaterThan(0)
    expect(Number(census[0][3]), census[0][0]).toBeGreaterThan(0)
    expect(Number(census[0][4]), census[0][0]).toBeGreaterThan(0)
    // G5, both routes: at least one spelling each, and every path it printed inside this run's sandbox.
    const runSandbox = join(rep.root, 'sandbox-root', runId)
    for (const route of ['through the Bash tool', 'through toolExec']) {
      const g5 = lines.map(l => new RegExp(`^\\[acceptance\\] ${route}: (\\S+) -> (.+)$`).exec(l)).filter(Boolean)
      expect(g5.length, `${route}\n${lines.join('\n')}`).toBeGreaterThan(0)
      for (const [l, , p] of g5) expect(insideRoot(runSandbox, p), l).toBe(true)
    }
    // G7's honest work: the four lines of canary c7, (a) to (d), in order; the commit and the temp file as the fake run shows them.
    const honest = lines.filter(l => l.startsWith('[acceptance] honest work: '))
    expect(honest.map(l => /^\[acceptance\] honest work: (\([a-d]\)) /.exec(l)?.[1]), honest.join('\n')).toEqual(['(a)', '(b)', '(c)', '(d)'])
    expect(honest[0]).toBe('[acceptance] honest work: (a) edit, add and commit passed')
    expect(honest[3]).toBe('[acceptance] honest work: (d) the temp file landed in the sandbox')
    // The audit of this run: at least one process wrote at least one record for it.
    const aud = lines.map(l => /^\[acceptance\] audit: 0 gap\(s\), 0 start\(s\) without an end, 0 unparsable line\(s\); files read: .+; (\d+) process\(es\) wrote (\d+) record\(s\) for (\S+)$/.exec(l)).filter(Boolean)
    expect(aud, lines.join('\n')).toHaveLength(1)
    expect(Number(aud[0][1]), aud[0][0]).toBeGreaterThanOrEqual(1)
    expect(Number(aud[0][2]), aud[0][0]).toBeGreaterThanOrEqual(1)
    expect(aud[0][3]).toBe(runId)
    // The finally block: the settling compare of this run unchanged, and the run released.
    expect(lines).toContain(`[acceptance] the settling compare for ${runId}: unchanged`)
    const released = lines.filter(l => l.startsWith('[acceptance] released: '))
    expect(released, lines.join('\n')).toHaveLength(1)
    expect(released[0].startsWith(`[acceptance] released: run ${runId} released`), released[0]).toBe(true)
    // The fake guard afterwards: no latch, no unsent page, no open baseline of the box.
    const guard = join(rep.root, 'guard')
    expect(existsSync(join(guard, 'HALT.json')), 'the fake guard holds the latch').toBe(false)
    expect(existsSync(join(guard, 'unsent')), 'the fake guard holds an unsent page').toBe(false)
    expect(readdirSync(join(guard, 'manifests')).filter(n => /^acceptance-real-.*\.before\.json$/i.test(n))).toEqual([])
    // No line of the rehearsal names a path below the real home outside the test root, except the two G5 information
    // lines, which print where the real home is (read only; the test root itself lies in the real temp folder).
    const fold = (p) => p.toLowerCase()
    const realHome = fold(homedir())
    const rootF = fold(rep.root)
    // Wave 11b, G8: and the rehearsal's own line that names the machine's folders it refuses a root to hold (read only).
    // Changed on purpose in wave 11c (H5): only the list after MACHINE_FOLDERS_MARK is left out, so a stray path in the
    // first half of that line is still caught.
    const info = ["[acceptance] [Environment]::GetFolderPath('UserProfile') -> ", '[acceptance] os.userInfo().homedir -> ']
    const astray = []
    const checked = lines.filter(x => !info.some(p => x.startsWith(p))).map(x => (x.startsWith(REHEARSAL_FOLDERS_LINE) && x.includes(MACHINE_FOLDERS_MARK) ? x.slice(0, x.indexOf(MACHINE_FOLDERS_MARK)) : x))
    for (const l of checked) {
      const text = l.replace(/\\\\/g, '\\').replace(/([A-Za-z]:)\//g, '$1\\')
      for (const raw of text.match(/[A-Za-z]:\\[^\s'"()<>|;,]*/g) ?? []) {
        const p = fold(raw.replace(/[.:\\/]+$/, '').replace(/\//g, '\\'))
        // A path the box's own print cut short (`after:` prints 300 characters of the answer) ends the line and is
        // the start of the test root's path.
        const cut = text.endsWith(raw) && rootF.startsWith(p)
        if ((p === realHome || p.startsWith(`${realHome}\\`)) && !(p === rootF || p.startsWith(`${rootF}\\`)) && !cut) astray.push(`${raw} in: ${l.slice(0, 200)}`)
      }
    }
    expect(astray, 'paths below the real home outside the test root').toEqual([])
  })

  it.skipIf(!WIN)('Windows: low integrity, every canary as rule F3 says, no label leak', (ctx) => {
    const rep = need(ctx)
    expect(rep.lowIntegrity).toBe('low')
    for (const c of ['c0', 'c1', 'c2', 'c3', 'c4', 'c6', 'c8']) expect(rep.canary[c], c).toBe('passed')
    expect(rep.canary.c5).toBe('reads are not blocked')
    expect(rep.canary.c7).not.toMatch(/FAILED/)
    expect(rep.labelLeak).toBe('none')
  })

  it.skipIf(WIN)('not Windows: the kernel layer is not applicable here; what this run shows is the path check and the overlay', (ctx) => {
    const rep = need(ctx)
    expect(rep.lowIntegrity).toBe('not-applicable')
    expect(rep.canary.c0).toBe('passed')
  })
})
