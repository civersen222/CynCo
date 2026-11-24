// F242: the acceptance script's pure helpers, the attack catalog, and ONE run of the fake-home stage
// (06-acceptance-records.md, tests T2 and T3).
//
// What this file never does: start the real-profile stage, start an inner run by hand, or spell the
// real-profile flag or its variable (they come from the script's own constants). The one spawn is
// `--stage fake --root <this file's own temp folder> --no-live-fire --json`: the destructive texts it
// holds are handed only to an executor that must refuse them, or are listing-only twins.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  REAL_PROFILE_FLAG, REAL_PROFILE_VAR, auditCountsFor, buildFakeProfile, censusOf, deepCountOf, evidenceRefusal, fakeRootRefusal, fakeStageRefusal,
  innerSelfCheck, insideRoot, leftBehindDrift, liveFireRefusal, parseDry, realStageRefusal, repointedEnv, runFakeStage, startInner, treeDigest,
} from '../cynco-containment-acceptance.mjs'
import { ATTACK_ORDER, BYPASS_SPELLINGS, DRY_BEGIN, DRY_END, LEFT_BEHIND, TARGET_DOT_FOLDER, attacks, protectedFolderCalls } from '../cynco-containment-attacks.mjs'
import { AUDIT_MARKER } from '../../engine/audit/toolAudit.js'
import { HARNESS_DIFF_FLAGS } from '../../engine/harnessGit.js'
import { operatorRefusal } from '../../engine/containment.js'

const WIN = process.platform === 'win32'
const roots = []
const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); roots.push(d); return d }
const linksToRemove = []
const gone = (p) => { try { lstatSync(p); return false } catch { return true } }
afterAll(() => {
  for (const l of linksToRemove) {
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
    expect(innerSelfCheck(args({ mode: 'other' }))).toBe('the inner mode other is not one of layers-off, full, live, unseen')
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
    expect(before).toEqual([{ name: '.a', files: 1, bytes: 3, unreadable: 0 }, { name: '.b', files: 1, bytes: 4, unreadable: 0 }])
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
      it('ATTACK_ORDER holds the eight ids once each, and the attacks come in that order', () => {
        expect(ATTACK_ORDER.length).toBe(8)
        expect(new Set(ATTACK_ORDER).size).toBe(8)
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
            for (const bad of ['GetFolderPath', 'userInfo', 'HOMEDRIVE', 'HOMEPATH', '&&', '||', '.ssh', '.env', 'tokens.json']) {
              expect(t.includes(bad), `${a.id} ${v.label}: ${t} contains ${bad}`).toBe(false)
            }
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
        const allowed = new RegExp(`^(cynco-acceptance-${NONCE}\\.(txt|ipynb)|out-${NONCE}|post-checkout)$`)
        for (const { a, v } of all) {
          const files = []
          if (v.call.tool !== 'Bash' && v.call.tool !== 'MultiEdit') files.push(v.call.input.file_path ?? v.call.input.notebook_path)
          if (v.call.tool === 'MultiEdit') files.push(v.call.input.edits[1].file_path)
          for (const f of files.filter(Boolean)) expect(basename(f), `${a.id} ${v.label}`).toMatch(allowed)
          for (const t of texts(v)) {
            for (const m of t.matchAll(/cynco-acceptance-[^\s'"\\/]*/g)) expect(m[0]).toMatch(new RegExp(`^cynco-acceptance-${NONCE}\\.(txt|ipynb)$`))
            for (const m of t.matchAll(/out-[^\s'"\\/]*/g)) expect(m[0]).toBe(`out-${NONCE}`)
          }
        }
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
        expect(gb.length).toBe(opts.gitBash ? 2 : 0)
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
    expect(BYPASS_SPELLINGS.length).toBe(6)
    expect(protectedFolderCalls(P, { shell: 'powershell' }).map(c => c.what)).toHaveLength(7)
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
    // Measured by the orchestrator from the real home's census before and after (read only).
    expect(report.realProfileLoss, 'no top-level dot-entry of the real home lost or halved (the presence rule; a write or a deeper change is not measured)').toBe(false)
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
      if (e.variant === 'c7 pytest' && e.outcome === 'not proven') { expect(e.detail).toMatch(/installed only in the real user site/); continue }
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
