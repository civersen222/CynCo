// F242, wave 10: the live-fire reader (`liveOutcome`) pinned to what Windows really prints when the kernel
// denies a low-integrity process, on the PC the suite runs on. Until now it was tested only against strings
// typed by hand, and live-2 came back INCOMPLETE because Windows PowerShell 5.1 wraps its own error records at
// 119 columns, which no hand-typed string had.
//
// What this file does: it makes a REAL low-integrity PowerShell (a copy of Windows PowerShell 5.1's
// powershell.exe granted to this user and labelled low: an executable labelled low starts a low process
// whoever starts it), builds the fake profile twice (a short root, and one under a long folder name so the wrap
// falls elsewhere), and hands the low PowerShell every catalog variant whose form is 'literal' and which live
// fire hands over as 'literal' or 'junction-literal', plus the two protected-folder deletes. Each must leave the
// fake root as it was and read 'denied', both as the Bash tool hands it back (the command with its trailing
// merge, wave 10b D8) and as stdout followed by stderr. Controls at the same level show that 'denied' is not an
// artefact: a delete in a folder labelled low succeeds; a missing path, a missing program and a program that
// cannot be started read 'not proven'. The four break points of the Remove-Item sentence are each produced on
// purpose, and the Bash tool's own answer to a merged command is checked once at medium integrity.
//
// How a form is started (wave 10c, T1): `spawnSync(<low powershell.exe>, ['-NoProfile', '-NonInteractive',
// '-c', <preamble + command>])`. The engine starts its shell as `powershell.exe -c <command>` (Node's and Bun's
// spawn with `shell`), which prints its error records as plain wrapped text; here PowerShell is the direct child,
// so nothing (no cmd, no -EncodedCommand, no CLIXML decoding) stands between what it printed and what the
// assertions read, and a timeout kills it. One case does nest on purpose (wave 18, (13)): a `powershell
// -EncodedCommand` started by the low PowerShell, whose CLIXML error stream the runner's reader decodes. Tried by hand on 2026-11-24 before this file was written: it starts,
// Windows' own whoami run through it shows S-1-16-4096, a denied Remove-Item prints plain wrapped text, a
// spawnSync timeout ends it (the pid is gone). -NoProfile keeps a profile's output out of every answer.
//
// What it never does: hand the low process a mission form or anything that names the home through a variable
// (a mission form would act on the real profile, whose AppData\LocalLow a low process may write), touch the real
// home, make a junction of its own, or label anything low but the copy of powershell.exe, the copy of whoami.exe
// of control (d) and the one small control folder. Every drive-letter path in a command must lie under the
// fixture's roots (T4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFakeProfile, denialWords, flatText, liveDisposition, liveOutcome, treeDigest, withStderrMerged } from '../cynco-containment-acceptance.mjs'
import { attacks, protectedFolderCalls } from '../cynco-containment-attacks.mjs'
import { bashTool, failedOutput, formatBashFailure } from '../../engine/tools/impl/bash.js'
import { getShellInfo } from '../../engine/tools/shellInfo.js'
import { isLinkEntry } from '../../engine/realPath.js'

const WIN = process.platform === 'win32'
const TAG = '[real-denials]'
const NOT_WIN = 'not Windows: there is no low-integrity process to start'
const sys = (exe) => join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe)
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
/** The engine's PowerShell preamble (`shellPreamble`, engine/tools/shellInfo.ts), before every command. */
const PREAMBLE = "$PSDefaultParameterValues['Out-File:Encoding']='utf8'; "
/**
 * Spellings that name a home or an application folder through a variable or an API: a form holding one is never
 * started. The last four since wave 10d (G1): PowerShell's braced variable, .NET's environment and known-folder
 * calls, and the profile's path.
 */
// 'env:' covers $env:, ${env: and the Env: drive (Get-Item Env:USERPROFILE); 'environment]::' covers [Environment]:: and
// [System.Environment]::, whatever method follows; '${home}' is $HOME in braces.
const HOME_SPELLINGS = ['$HOME', '${home}', 'env:', '~', '%USERPROFILE%', '%LOCALAPPDATA%', '%APPDATA%', '%HOMEPATH%', 'environment]::', 'GetFolderPath', '$PROFILE']
const START_TIMEOUT_MS = 30_000
const NONCE = 'b0a710e5'
/** The width Windows PowerShell 5.1 wraps its own error records at when its output is a pipe (brief-b, measured). */
const WRAP = 119

// ---- G2 (wave 10d): what the temp folder's length allows, decided when the file is collected ----
/** The temp folder as the roots will see it: `temp()` takes the long form of every folder it makes. */
const TMP_REAL = (() => { try { return realpathSync.native(tmpdir()) } catch { return tmpdir() } })()
/** The length of a folder `temp(prefix)` makes: the temp folder, a separator, the prefix and mkdtemp's six characters. */
const tempLength = (prefix) => TMP_REAL.length + 1 + prefix.length + 6
/**
 * The long root is `<temp>\cynco-real-l-XXXXXX\<name>`. Its length is held at 125 characters, what it is on the PC
 * this file was written on (a 33-character temp folder and a 71-character name), so the home's paths and where
 * PowerShell wraps them are the same whatever the temp folder; the name is never shorter than 8 characters, so the
 * long root always differs from the short one and the wrap falls elsewhere. A fixed 71-character name under a
 * 100-character temp folder took the fake profile's deepest path (a git hook sample) past what git can stat.
 */
const LONG_ROOT_LENGTH = 125
const LONG_NAME_LENGTH = Math.max(8, LONG_ROOT_LENGTH - tempLength('cynco-real-l-') - 1)
const LONG_NAME = ('wrap-shift-' + 'abcdefghij'.repeat(Math.ceil(LONG_NAME_LENGTH / 10))).slice(0, LONG_NAME_LENGTH)

/** T8: the Remove-Item sentence, and where each break point needs the line's `<path>:` to end (with its colon). */
const SENT = ['Access', 'to', 'the', 'path', 'is', 'denied.']
const sentEnd = (k) => SENT.slice(0, k + 1).reduce((n, w) => n + 1 + w.length, 0) // " Access", " Access to", ...
// The line holding `<path>:` (s characters) then the sentence keeps its trailing space and holds at most WRAP
// characters (measured 2026-11-24 by hand, a file name one character longer at a time). The path stands at the
// start of its own line when it cannot follow "Remove-Item : Cannot remove item " (33 characters).
const rangeOf = (k) => ({ lo: WRAP - sentEnd(k + 1) - (k + 1 === SENT.length - 1 ? 0 : 1) + 1, hi: WRAP - sentEnd(k) - 1 })
const breakAt = (k) => { const { lo, hi } = rangeOf(k); return Math.floor((lo + hi) / 2) }
/**
 * Why T8 cannot run under the temp folder `tmpReal`, or null: a padded file `<pad>\<name>` needs a name of one character
 * at least for every break. Wave 18 (plan P6 (14)): the skip names the temp folder itself, not only its length. A short
 * root of T8's own is not built: a test makes folders only inside the temp folder, so none can be shorter than it.
 */
function t8SkipFor(tmpReal, win = WIN) {
  if (!win) return NOT_WIN
  if (/\s/.test(tmpReal)) return `the temp folder's path holds white space, where PowerShell may break the line: ${tmpReal}`
  const pad = tmpReal.length + 1 + 'cynco-real-p-'.length + 6
  const room = Math.min(...SENT.slice(0, -1).map((_, k) => breakAt(k))) - 3 // s - 1 - (pad + 1) >= 1
  if (pad > room) return `the temp folder's path ${tmpReal} (${tmpReal.length} characters) is too long for the padded paths: its padded folder would be ${pad} characters, at most ${room} leaves a file name for every break point`
  return null
}
const T8_SKIP = t8SkipFor(TMP_REAL)
if (WIN && T8_SKIP !== null) console.log(`${TAG} T8 is skipped: ${T8_SKIP}`)

/** A python found by its full path (never the store's alias), or null with the reason. A lookup, not the fixture. */
const python = (() => {
  if (!WIN) return { path: null, why: NOT_WIN }
  const w = spawnSync(sys('where.exe'), ['python'], { encoding: 'utf-8', windowsHide: true, timeout: START_TIMEOUT_MS })
  const found = String(w.stdout).split(/\r?\n/).map(s => s.trim()).filter(s => s !== '' && !/WindowsApps/i.test(s) && existsSync(s))
  for (const p of found) {
    const v = spawnSync(p, ['-c', 'print(1)'], { encoding: 'utf-8', windowsHide: true, timeout: START_TIMEOUT_MS })
    if (v.status === 0 && String(v.stdout).trim() === '1') return { path: p, why: null }
  }
  return { path: null, why: `no python that runs was found by its full path (where.exe answered: ${String(w.stdout + w.stderr).trim().slice(0, 200) || 'nothing'})` }
})()
if (WIN && python.path === null) console.log(`${TAG} the python literal forms are skipped: ${python.why}`)

// ---- What the cleanup must find, registered the moment each thing exists (T2) ----
const roots = []
const links = []
const denied = []
const temp = (prefix) => {
  // The long form of the temp folder: a short 8.3 name would put a `~` into every command.
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(d)
  return d
}
const icacls = (args) => spawnSync(sys('icacls.exe'), args, { encoding: 'utf-8', windowsHide: true, timeout: START_TIMEOUT_MS })
const icaclsOk = (args) => {
  const r = icacls(args)
  if (r.status !== 0) throw new Error(`icacls ${args.join(' ')} failed: ${String((r.stdout ?? '') + (r.stderr ?? '')).trim().slice(0, 200)}`)
}
const gone = (p) => { try { realpathSync.native(p); return false } catch { return isLinkEntry(p) !== true } }
/** Every link entry under `dir`, by the folder's own listing; a link is never entered. */
function linksIn(dir, failures) {
  const out = []
  let list
  try { list = readdirSync(dir, { withFileTypes: true }) } catch (e) { failures.push(`${dir} could not be listed (${e.code ?? e.message})`); return out }
  for (const d of list) {
    const p = join(dir, d.name)
    if (d.isSymbolicLink()) out.push(p)
    else if (d.isDirectory()) out.push(...linksIn(p, failures))
  }
  return out
}
/** Removes one link as an entry (rmdir, then unlink), never through it. Answers whether it is gone. */
function removeLink(l, failures) {
  if (gone(l)) return true
  try { rmdirSync(l) } catch { try { unlinkSync(l) } catch (e) { failures.push(`the link ${l} could not be removed: ${e.message}`) } }
  if (gone(l)) return true
  failures.push(`the link ${l} is still there`)
  return false
}

/** What the cleanup does to the file system; a test hands it steps that throw (G4). */
const CLEAN_OPS = {
  exists: (p) => existsSync(p),
  removeLink: (l, failures) => removeLink(l, failures),
  linksIn: (d, failures) => linksIn(d, failures),
  reset: (f) => {
    const r = icacls([f, '/reset'])
    if (r.status !== 0) throw new Error(`icacls ${f} /reset failed: ${String(r.stdout + r.stderr).trim().slice(0, 200)}`)
  },
  removeRoot: (d) => rmSync(d, { recursive: true, force: true, maxRetries: 5 }),
}
/**
 * Whatever exists, even after a throw: the links first, one entry at a time (a recursive delete through a
 * junction made at low integrity would walk into its target, which lstat cannot tell from a folder), then any
 * link the listing still shows under a root, then the deny entries, then the roots. Answers the failures, which
 * the caller asserts at the end. G4 (wave 10d): every step, each link removal included, has its own catch that
 * records the failure and lets the rest run. A root is never deleted recursively while a link under it may still be
 * there (its removal failed or threw) or while it could not be listed for links (a link may be in it unseen).
 */
function cleanUp(state, ops) {
  const failures = []
  const step = (what, fn) => {
    try { return { ok: true, value: fn() } } catch (e) { failures.push(`${what}: ${e?.message ?? e}`); return { ok: false } }
  }
  const kept = [] // links that may still be there
  const unlisted = new Set() // roots that could not be listed for links
  const dropLink = (l) => {
    const r = step(`the link ${l} could not be removed`, () => ops.removeLink(l, failures))
    if (!r.ok || r.value === false) kept.push(l)
    // Wave 18 (plan P6 (14)): a link gone on its second try no longer keeps its root in place.
    else for (let i = kept.length - 1; i >= 0; i--) if (kept[i].toLowerCase() === l.toLowerCase()) kept.splice(i, 1)
  }
  const within = (p, d) => p.toLowerCase().startsWith(d.toLowerCase() + '\\') || p.toLowerCase().startsWith(d.toLowerCase() + '/')
  for (const l of state.links) dropLink(l)
  for (const d of state.roots) {
    const e = step(`${d} could not be checked`, () => ops.exists(d))
    if (e.ok && !e.value) continue
    const before = failures.length
    const found = step(`${d} could not be listed for links`, () => ops.linksIn(d, failures))
    if (!found.ok || failures.length > before) unlisted.add(d)
    for (const l of found.ok ? found.value : []) {
      // Wave 18 (plan P6 (14)): a registered link whose first removal failed is found here again; it is tried a second
      // time, and said so, never called a link nobody registered. What the second try did is recorded by dropLink.
      const registered = state.links.some(x => x.toLowerCase() === l.toLowerCase())
      failures.push(registered
        ? `the registered link ${l} was still under ${d} after its first removal; it is tried again as an entry`
        : `a link nobody registered was under ${d}: ${l} (removed as an entry)`)
      dropLink(l)
    }
  }
  for (const f of state.denied) {
    const e = step(`${f} could not be checked`, () => ops.exists(f))
    if (e.ok && !e.value) continue
    step(`the deny entry of ${f} could not be reset`, () => ops.reset(f))
  }
  for (const d of state.roots) {
    // Never a recursive delete past a link that stayed, or through a folder nobody could list for links.
    const stays = kept.filter(l => within(l, d))
    if (stays.length > 0 || unlisted.has(d)) {
      failures.push(`${d} is left in place: ${stays.length > 0 ? `a link under it may still be there (${stays.join(', ')})` : 'it could not be listed for links'}`)
      continue
    }
    step(`${d} could not be removed`, () => ops.removeRoot(d))
    const e = step(`${d} could not be checked after its removal`, () => ops.exists(d))
    if (e.ok && e.value) failures.push(`${d} is still there`)
  }
  return failures
}

afterAll(() => {
  expect(cleanUp({ links, roots, denied }, CLEAN_OPS), 'the cleanup').toEqual([])
})

/** The fixture of every case, built in `beforeAll` (T2). `error` is why it could not be made (T3). */
const F = { error: null, low: null, fixtures: [], pad: null }
/** The fixture, or a FAILED case that says why it could not be made (T3: on Windows never a skip). */
function need() {
  if (F.error !== null) throw new Error(`the fixture could not be made: ${F.error}`)
  if (F.low === null) throw new Error('the fixture was not built')
  return F
}

/** How `command` is handed to the low copy of Windows PowerShell 5.1: the file, its arguments and the spawn options. */
function lowSpawn(command, timeout = START_TIMEOUT_MS) {
  const env = { ...process.env, TEMP: F.low.tmp, TMP: F.low.tmp }
  // G1 (wave 10d): it starts in the low control folder, so a relative path can only land in a folder labelled low.
  return { file: F.low.ps, args: ['-NoProfile', '-NonInteractive', '-c', PREAMBLE + command], options: { encoding: 'utf-8', windowsHide: true, timeout, env, cwd: F.low.ctl } }
}
/** Starts `command` (the preamble first) in the low copy of Windows PowerShell 5.1, in the engine's `-c` shape. */
function startLow(command, timeout = START_TIMEOUT_MS) {
  const { file, args, options } = lowSpawn(command, timeout)
  const t0 = Date.now()
  const r = spawnSync(file, args, options)
  const ms = Date.now() - t0
  return { code: r.status, error: r.error ? (r.error.code ?? r.error.message) : null, pid: r.pid, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), ms }
}
function startLowOk(command) {
  const r = startLow(command)
  if (r.error) throw new Error(`the low PowerShell could not be started or was killed at its timeout (${r.error})`)
  return r
}

/** The low process (T1): a copy of powershell.exe granted to this user and labelled low, proven by Windows' own whoami. */
function buildLow() {
  const user = process.env.USERNAME
  if (!user) throw new Error('USERNAME is not set, so the copy of powershell.exe cannot be granted to this user')
  if (!existsSync(POWERSHELL)) throw new Error(`Windows PowerShell 5.1 is not at ${POWERSHELL}`)
  const base = temp('cynco-real-low-')
  const ps = join(base, 'lowps.exe')
  copyFileSync(POWERSHELL, ps)
  icaclsOk([ps, '/grant', `${user}:(F)`])
  icaclsOk([ps, '/setintegritylevel', 'low'])
  // The one folder labelled low: control (a), the junction's scratch folders (T7), control (d)'s program, the TEMP of the low children.
  const ctl = join(base, 'lowctl')
  mkdirSync(ctl)
  icaclsOk([ctl, '/grant', `${user}:(OI)(CI)(F)`])
  icaclsOk([ctl, '/setintegritylevel', '(OI)(CI)low'])
  const tmp = join(ctl, 'tmp')
  mkdirSync(tmp)
  F.low = { user, base, ps, ctl, tmp }
  const who = startLowOk(`& '${sys('whoami.exe')}' /groups`)
  if (!/S-1-16-4096/.test(who.stdout)) {
    F.low = null
    throw new Error(`the low copy of powershell.exe does not run at low integrity (exit ${who.code}): ${(who.stdout + who.stderr).slice(0, 300)}`)
  }
  F.low.who = who.stdout.split(/\r?\n/).find(l => /S-1-16-4096/.test(l))?.replace(/\s+/g, ' ').trim()
}

/** One fake profile with what live fire's protected-folder step adds (the latch, the day's audit file) and the catalog's `p`. */
function fixture(tag, root) {
  const fake = buildFakeProfile(root, NONCE)
  links.push(...fake.links)
  if (fake.linkError) throw new Error(fake.linkError)
  writeFileSync(join(fake.guard, 'HALT.json'), NONCE, { flag: 'wx' })
  writeFileSync(join(fake.audit, '2026-11-24.jsonl'), '{}\n', { flag: 'wx' })
  // T7: the junction's scratch folder is in the folder labelled low, so the low process may make a folder there and
  // a denial is the kernel refusing a junction to a medium folder, not a missing parent.
  const scratch = join(F.low.ctl, `scratch-${tag}`)
  mkdirSync(scratch)
  const p = paramsOf(fake, root, scratch)
  return { tag, root, fake, p, forms: formsOf(p) }
}
function paramsOf(fake, root, scratch) {
  return {
    home: fake.home, cwd: fake.mission, scratch, linked: fake.linked, guard: fake.guard,
    audit: fake.audit, models: fake.models, sandboxRootOther: join(root, 'sandbox-root', 'acc-other-20260101T000000-0000'), nonce: NONCE,
    date: new Date(2026, 10, 24),
    dotEntries: readdirSync(fake.home).filter(n => n.startsWith('.')),
    localEntries: readdirSync(join(fake.home, 'AppData', 'Local')), roamingEntries: readdirSync(join(fake.home, 'AppData', 'Roaming')),
  }
}

/** The forms for one fixture: every Bash literal variant live fire hands over as 'literal' or 'junction-literal', and the two protected deletes. */
function formsOf(p) {
  const out = []
  for (const a of attacks({ shell: 'powershell', python: python.path, gitBash: null })) {
    for (const v of a.variants(p)) {
      const kind = liveDisposition(a.id, v)?.kind
      if (v.form !== 'literal' || v.call?.tool !== 'Bash' || (kind !== 'literal' && kind !== 'junction-literal')) continue
      out.push({ id: a.id, label: v.label, variant: v.variant, form: v.form, kind, command: v.call.input.command, targets: v.targets ?? [], creates: v.creates ?? [] })
    }
  }
  for (const pc of protectedFolderCalls(p, { shell: 'powershell' })) {
    if (pc.what !== 'delete the latch' && pc.what !== 'delete the audit file') continue
    out.push({ id: 'protected-folder', label: pc.what, variant: 'powershell', form: 'literal', kind: 'literal', command: pc.call.input.command, targets: pc.targets, creates: [] })
  }
  return out
}
const keyOf = (x) => `${x.id} / ${x.label} / ${x.variant} / ${x.kind}`

/**
 * The case names, known when the file is collected (the real paths exist only once `beforeAll` ran): the same
 * catalog over a placeholder fixture. The fixture's case asserts that the real list has the same keys in order.
 */
const placeholderForms = (() => {
  const r = 'C:\\cynco-placeholder'
  const home = join(r, 'profile', 'Users', 'tester')
  return formsOf({
    home, cwd: join(r, 'mission'), scratch: join(r, 'lowctl', 'scratch'), linked: join(r, 'linked'), guard: join(r, 'guard'),
    audit: join(r, 'audit'), models: join(r, 'models'), sandboxRootOther: join(r, 'sandbox-root', 'other'), nonce: NONCE,
    date: new Date(2026, 10, 24), dotEntries: ['.cynco', '.ssh'], localEntries: ['A'], roamingEntries: ['B'],
  })
})()

beforeAll(() => {
  if (!WIN) return
  try {
    buildLow()
    const short = temp('cynco-real-s-')
    // A long folder name puts the home's paths past PowerShell's 119 columns earlier, so the wrap falls elsewhere.
    const longBase = temp('cynco-real-l-')
    const long = join(longBase, LONG_NAME) // G2: its length derived from the temp folder's
    mkdirSync(long)
    for (const [tag, root] of [['short', short], ['long', long]]) F.fixtures.push(fixture(tag, root))
    F.pad = temp('cynco-real-p-')
  } catch (e) {
    F.error = e?.message ?? String(e)
    console.log(`${TAG} the fixture could not be made: ${F.error}`)
  }
}, 120_000)

/**
 * T4: a command may be started only when every drive-letter path in it lies under one of `allowed` (the fixture's
 * roots and the low control folder) or is the python found by its full path, no path climbs with `..`, none is a
 * UNC or device path, and it holds no home spelling. Fails the case otherwise.
 */
function assertSafe(command, allowed) {
  const text = String(command)
  const lower = text.toLowerCase()
  for (const s of HOME_SPELLINGS) expect(lower.includes(s.toLowerCase()), `the command holds ${s}: ${text}`).toBe(false)
  expect(/\\\\/.test(text), `the command holds a UNC or device path: ${text}`).toBe(false)
  // G1 (wave 10d): a drive letter with its colon and no separator after it (`C:Users\...`) is relative to that
  // drive's current folder, which nothing here controls; and a '..' segment anywhere climbs, inside a drive-letter
  // path or not (`Set-Location ..`, `'..\Users'`). A segment ends at a separator, a quote, white space, a
  // statement or argument character, or the end of the text; three dots are not two. Wave 18 (plan P6 (14)): a bare
  // drive followed by white space (`Remove-Item C: -Recurse`) is refused too. Until then a colon followed by white space
  // was let through for the catalog's python literals, which held `lambda f, x, i: ...`; their handler's parameters
  // now have names longer than one letter, so no single letter and colon stands in any form.
  const driveRelative = /(?<![A-Za-z0-9])[A-Za-z]:(?![\\/])/.exec(text)
  expect(driveRelative, `the command holds a drive letter with no separator after its colon: ${driveRelative?.[0]} in ${text}`).toBeNull()
  const climb = /(?<=^|[\\/\s'"=;,(){}[\]:|&<>])\.\.(?=$|[\\/\s'"=;,(){}[\]|&<>])/.exec(text)
  expect(climb, `the command holds a '..' segment: ${text}`).toBeNull()
  // A path that starts at the root of the current drive (`'\Users\x'`, `'/Users/x'`, `Set-Location \`) names no drive, so the
  // check below never sees it, and on C: it lands in the real profile. A backslash that opens a token; or a slash that
  // opens a token and has a second slash after a name (cmd's own flags, `/c`, `/s`, `/q`, `/J`, have none).
  const rootRelative = /(?<=^|[\s'"=(,;])\\(?!\\)|(?<=^|[\s'"=(,;])\/[^\s'"\/]+\//.exec(text)
  expect(rootRelative, `the command holds a path from the root of the current drive: ${text}`).toBeNull()
  const starts = [...text.matchAll(/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/g)].map(m => m.index)
  expect(starts.length, `the command names no drive-letter path: ${text}`).toBeGreaterThan(0)
  const under = (rest, root) => {
    const l = rest.toLowerCase()
    const r = root.toLowerCase()
    return l.startsWith(r) && (l.length === r.length || /[\\/'"\s]/.test(l[r.length]))
  }
  for (const i of starts) {
    const rest = text.slice(i)
    const token = /^[^'"\r\n]*/.exec(rest)[0]
    expect(/(^|[\\/])\.\.([\\/]|$)/.test(token), `the path climbs with '..': ${token}`).toBe(false)
    const isPython = python.path !== null && under(rest, python.path)
    expect(isPython || allowed.some(r => under(rest, r)), `a path outside the fixture: ${token} (allowed: ${allowed.join(', ')})`).toBe(true)
  }
}

/** What the Bash tool hands back for this result, the command handed with its trailing merge (D8; T5 for exit 0). */
function toolShape(command, r) {
  const merged = withStderrMerged(command)
  if (r.code !== 0) return formatBashFailure(merged, failedOutput(r.stderr, r.stdout, r.code, 'shell=powershell.exe, signal=none'))
  // T5: a merged success is both streams, stdout first (F60), as the tool assembles it; G3 (wave 10d): with the
  // tool's own '(no output)' for a silent success since E1 (engine/tools/impl/bash.ts), not the silent-failure text.
  return failedOutput(r.stderr, r.stdout, 0, undefined, '(no output)')
}
const streamsShape = (r) => `${r.stdout}${r.stderr}`
const carriedBy = (r) => {
  const o = denialWords(r.stdout) !== null
  const e = denialWords(r.stderr) !== null
  return o && e ? 'both' : o ? 'stdout' : e ? 'stderr' : 'neither'
}

describe('the reader against real low-integrity denials (Windows PowerShell 5.1, cmd, python)', () => {
  it.skipIf(!WIN)(`the fixture: a low PowerShell exists, and every form list is the catalog's literal Bash forms${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
    const { low, fixtures } = need()
    console.log(`${TAG} the low PowerShell: ${low.ps} | whoami through it: ${low.who}`)
    expect(low.who).toMatch(/S-1-16-4096/)
    // G1 (wave 10d): the low process starts in the low control folder, so a relative path in a form can only land
    // there, never in the folder the suite happens to run from.
    expect(lowSpawn('x').options.cwd, 'the working folder of the low process').toBe(low.ctl)
    for (const f of fixtures) {
      console.log(`${TAG} ${f.tag} root (${f.root.length} characters): ${f.forms.length} forms`)
      // G2: the roots are as long as the collection-time arithmetic said (the long one held at LONG_ROOT_LENGTH while the temp folder allows it).
      expect(f.root.length).toBe(f.tag === 'short' ? tempLength('cynco-real-s-') : tempLength('cynco-real-l-') + 1 + LONG_NAME_LENGTH)
      // write-dot-folder 1, junction 2 (the delete through a link and, since wave 10c T7, the create literal read as
      // 'junction-literal'), rm-home-cynco 1, cmd-rd 1, appdata-walk 6, rm-all-dot 1, python-rmtree 1, ps-pipeline 1,
      // and the two protected deletes. Was 15 before T7 added the junction create literal on purpose.
      expect(f.forms.length).toBe(16)
      expect(f.forms.map(keyOf), 'the real list differs from the one the cases were named from').toEqual(placeholderForms.map(keyOf))
      for (const x of f.forms) expect(x.form).toBe('literal')
      expect(f.forms.filter(x => x.id === 'protected-folder').length).toBe(2)
      expect(f.forms.filter(x => x.kind === 'junction-literal').map(x => x.label)).toEqual(['create literal'])
    }
  }, 60_000)

  it.skipIf(!WIN)(`a timeout ends the low PowerShell, its direct child${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
    need()
    const r = startLow('Start-Sleep -Seconds 60', 2_000)
    const t = spawnSync(sys('tasklist.exe'), ['/fi', `PID eq ${r.pid}`, '/nh'], { encoding: 'utf-8', windowsHide: true, timeout: START_TIMEOUT_MS })
    console.log(`${TAG} timeout | ${r.ms} ms | ${r.error} | tasklist: ${String(t.stdout).trim()}`)
    expect(r.error).toBe('ETIMEDOUT')
    expect(String(t.stdout)).not.toMatch(/lowps\.exe/i)
  }, 60_000)

  for (const tag of ['short', 'long']) {
    describe(`${tag} root`, () => {
      placeholderForms.forEach((ph, i) => {
        // The python-rmtree literal is labelled by its shell ('powershell literal'), so the attack is named too.
        const needsPython = ph.variant === 'python' || ph.id === 'python-rmtree'
        const skip = !WIN ? NOT_WIN : (needsPython && python.path === null) ? python.why : null
        it.skipIf(skip !== null)(`${ph.id} / ${ph.label}: nothing changes, and it reads 'denied' from both shapes${skip ? ` (skipped: ${skip})` : ''}`, () => {
          const f = need().fixtures.find(t => t.tag === tag)
          const x = f.forms[i]
          expect(keyOf(x)).toBe(keyOf(ph))
          assertSafe(x.command, [f.root, F.low.ctl])
          expect(x.form).toBe('literal')
          const digestBefore = treeDigest(f.root)
          const present = x.targets.filter(t => existsSync(t))
          // A form that only creates (write-dot-folder's: its target is the file it would make) is judged by what
          // it made, and the folder it would make it in must be there; every other form needs a target to act on.
          const createsOnly = x.targets.length > 0 && x.targets.every(t => x.creates.includes(t))
          if (createsOnly) for (const t of x.targets) expect(existsSync(join(t, '..')), `the folder of ${t} is not there`).toBe(true)
          else expect(present.length, `no target of ${x.label} exists before the start`).toBeGreaterThan(0)
          const madeBefore = new Set(x.creates.filter(c => existsSync(c)))
          expect([...madeBefore], 'what the form would make is there before it starts').toEqual([])
          const link = x.kind === 'junction-literal' ? x.creates[0] : null
          if (link !== null) {
            links.push(link) // registered before the start: a link made after all is removed by afterAll even if this case throws
            expect(existsSync(join(link, '..')), `the scratch folder of ${link} is not there`).toBe(true)
          }

          const r = startLowOk(x.command)
          const lost = present.filter(t => !existsSync(t))
          const madeInHome = x.creates.filter(c => !madeBefore.has(c) && existsSync(c) && c !== link)
          let linkMade = false
          let landed = null
          if (link !== null && (isLinkEntry(link) === true || existsSync(link))) {
            linkMade = true
            try { landed = realpathSync.native(link) } catch { landed = null }
            try { rmdirSync(link) } catch (e) { console.log(`${TAG} the link ${link} could not be removed here (${e.message}); afterAll tries again`) }
          }
          const tool = toolShape(x.command, r)
          const both = streamsShape(r)
          const read = (output) => x.kind === 'junction-literal'
            ? liveOutcome({ kind: 'junction-literal', isError: r.code !== 0, output, lost, name: link, linkMade, landed })
            : liveOutcome({ kind: 'literal', tool: 'Bash', isError: r.code !== 0, output, lost, madeInHome })
          const oTool = read(tool)
          const oBoth = read(both)
          const by = carriedBy(r)
          // Without the merge the tool hands back `stdout || stderr` on exit 0: recorded, so a form that needs the merge shows.
          const unmerged = r.code === 0 ? (r.stdout || r.stderr || '(no output)') : null
          const mergeNeeded = unmerged !== null && denialWords(unmerged) === null
          // The two lines where the denial was written, as the stream carried them (the wrap shows here).
          const stream = by === 'stdout' ? r.stdout : r.stderr
          const lines = stream.split('\n')
          const at = Math.max(0, lines.findIndex((l, j) => denialWords(l + ' ' + (lines[j + 1] ?? '')) !== null))
          console.log(`${TAG} ${tag} | ${x.id} / ${x.label} | exit ${r.code} | ${r.ms} ms | denial on ${by}${mergeNeeded ? ' (exit 0: only the merge shows it)' : ''} | tool shape: ${oTool.outcome} | stdout+stderr: ${oBoth.outcome} | words: ${JSON.stringify(denialWords(both))} | as written: ${JSON.stringify(lines.slice(at, at + 2).join('\n').slice(-200))}`)
          if (oBoth.outcome !== 'denied' || oTool.outcome !== 'denied') {
            console.log(`${TAG} FINDING ${tag} ${x.id} / ${x.label}: stdout ${JSON.stringify(r.stdout)} stderr ${JSON.stringify(r.stderr)} tool ${JSON.stringify(tool)} | tool reading: ${oTool.detail} | both reading: ${oBoth.detail}`)
          }

          // (a) the fake root is as it was, every target is still there, nothing was made, no link.
          expect(linkMade, `a contained child made the link ${link}, which lands at ${landed}`).toBe(false)
          expect(lost, 'targets gone').toEqual([])
          expect(madeInHome, 'made in the home').toEqual([])
          expect(treeDigest(f.root), 'the fake root changed').toBe(digestBefore)
          if (link !== null) expect(readdirSync(join(link, '..')), 'the scratch folder is not empty').toEqual([])
          // The -c shape writes plain text; nothing in this file decodes or rewrites what PowerShell printed (T1).
          expect(r.stderr.includes('#< CLIXML'), 'PowerShell wrote CLIXML').toBe(false)
          // (b) both shapes read 'denied': the Bash tool's answer to the merged command (T5 on exit 0) and the streams.
          expect(oBoth.outcome, `stdout+stderr: ${oBoth.detail}`).toBe('denied')
          expect(oTool.outcome, `the Bash tool's answer (exit ${r.code}): ${oTool.detail}`).toBe('denied')
          expect(by, 'no stream named the denial').not.toBe('neither')
        }, 60_000)
      })
    })
  }

  describe('controls at the same low integrity', () => {
    it.skipIf(!WIN)(`(a) a Remove-Item on a file in a folder labelled low deletes it: the low child really acts${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
      const { low } = need()
      const victim = join(low.ctl, `victim-${NONCE}.txt`)
      writeFileSync(victim, 'x')
      const command = `Remove-Item -Force -LiteralPath '${victim}'`
      assertSafe(command, [low.ctl])
      const r = startLowOk(command)
      console.log(`${TAG} control (a) | exit ${r.code} | ${r.ms} ms | stdout ${JSON.stringify(r.stdout)} | stderr ${JSON.stringify(r.stderr)}`)
      expect(existsSync(victim), 'the low child did not delete a file in a folder labelled low').toBe(false)
      expect(r.code).toBe(0)
      // The reader sees a real loss as a loss.
      expect(liveOutcome({ kind: 'literal', tool: 'Bash', isError: false, output: streamsShape(r), lost: [victim], madeInHome: [] }).outcome).toBe('FAILED')
    }, 60_000)

    it.skipIf(!WIN)(`(b) a path that does not exist reads 'not proven', because the answer names no denial${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
      const f = need().fixtures[0]
      const missing = join(f.fake.home, '.cynco', `cynco-not-here-${NONCE}.bin`)
      const command = `Remove-Item -Force -LiteralPath '${missing}'`
      assertSafe(command, [f.root])
      const digestBefore = treeDigest(f.root)
      const r = startLowOk(command)
      console.log(`${TAG} control (b) | exit ${r.code} | ${r.ms} ms | stderr ${JSON.stringify(r.stderr)}`)
      expect(treeDigest(f.root)).toBe(digestBefore)
      expect(r.code).not.toBe(0)
      expect(flatText(r.stderr)).toMatch(/because it does not exist/)
      for (const output of [toolShape(command, r), streamsShape(r)]) {
        expect(denialWords(output), 'a missing path read as a denial').toBeNull()
        const o = liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output, lost: [], madeInHome: [] })
        expect(o.outcome).toBe('not proven')
        expect(o.detail).toMatch(/names no access denial/)
      }
    }, 60_000)

    it.skipIf(!WIN)(`(c) a program that is not there reads 'not proven', because the answer names no denial${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
      need()
      const command = `cynco-no-such-program-${NONCE}`
      const r = startLowOk(command)
      console.log(`${TAG} control (c) | exit ${r.code} | ${r.ms} ms | stderr ${JSON.stringify(r.stderr)}`)
      expect(r.code).not.toBe(0)
      expect(flatText(r.stderr)).toMatch(/is not recognized/)
      for (const output of [toolShape(command, r), streamsShape(r)]) {
        expect(denialWords(output), 'a missing program read as a denial').toBeNull()
        const o = liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output, lost: [], madeInHome: [] })
        expect(o.outcome).toBe('not proven')
        expect(o.detail).toMatch(/names no access denial/)
      }
    }, 60_000)

    // T6 (d): PowerShell that cannot START a native program prints "Program '<x>' failed to run: Access is denied":
    // the program never ran, so the words name no denial of what the form was to do. Decided (wave 10c, C1): such
    // an answer reads 'not proven'. The deny-execute entry is on a copy this file made, and is reset at once.
    it.skipIf(!WIN)(`(d) a program the low process cannot start reads 'not proven', not 'denied'${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
      const { low } = need()
      const w = join(low.ctl, 'w.exe')
      copyFileSync(sys('whoami.exe'), w)
      denied.push(w)
      icaclsOk([w, '/deny', `${low.user}:(X)`])
      const command = `& '${w}' /groups`
      assertSafe(command, [low.ctl])
      let r
      try {
        r = startLowOk(command)
      } finally {
        icaclsOk([w, '/reset'])
      }
      const readings = [toolShape(command, r), streamsShape(r)].map(output => liveOutcome({ kind: 'literal', tool: 'Bash', isError: r.code !== 0, output, lost: [], madeInHome: [] }))
      console.log(`${TAG} control (d) | exit ${r.code} | ${r.ms} ms | stdout ${JSON.stringify(r.stdout)} | stderr ${JSON.stringify(r.stderr)} | tool shape: ${readings[0].outcome} (${readings[0].detail}) | stdout+stderr: ${readings[1].outcome}`)
      // The premise: this is the measured text of a program that never started.
      expect(r.code).not.toBe(0)
      expect(r.stdout).toBe('')
      expect(flatText(r.stderr)).toMatch(/Program 'w\.exe' failed to run: Access is denied/)
      for (const o of readings) {
        expect(o.outcome, o.detail).toBe('not proven')
        expect(o.detail).toMatch(/could not be started/)
      }
    }, 60_000)
  })

  // Wave 18 (plan P6 (13)): a nested `powershell -EncodedCommand` writes its error records as CLIXML (`#< CLIXML`, one
  // `<S S="Error">` element per line, its line breaks escaped as `_x000D__x000A_`). The low PowerShell hands the
  // catalog's Remove-Item literal of the long root to such a nested PowerShell (itself low: its parent is), and the
  // reader must read the kernel's denial from that stream, both as the Bash tool hands it back and as the two streams.
  it.skipIf(!WIN)(`(13) a nested powershell -EncodedCommand answers in CLIXML, and the denial is read from it${WIN ? '' : ` (skipped: ${NOT_WIN})`}`, () => {
    const f = need().fixtures.find(t => t.tag === 'long')
    const x = f.forms.find(y => y.id === 'rm-home-cynco')
    expect(x.command).toMatch(/^Remove-Item -Recurse -Force '/)
    assertSafe(x.command, [f.root])
    const command = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(x.command, 'utf16le').toString('base64')}`
    const digestBefore = treeDigest(f.root)
    const present = x.targets.filter(t => existsSync(t))
    expect(present.length).toBeGreaterThan(0)
    const r = startLowOk(command)
    // Wave 18b (check 3 R6): what the decoder adds. `undecoded` is the reader on the stream as it came, its marker taken
    // away so that nothing decodes it (the old reading dropped the tags and the escaped breaks, a decode in itself).
    // `split`: no one Error element holds the sentence, so PowerShell's wrap fell inside it; then only the decoder reads it.
    const decoded = denialWords(r.stderr)
    const undecoded = denialWords(r.stderr.replace(/#< CLIXML/g, ''))
    const elements = [...r.stderr.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(m => m[1].replace(/_x000D__x000A_/g, ' '))
    const split = !elements.some(t => denialWords(t) !== null)
    console.log(`${TAG} (13) | exit ${r.code} | ${r.ms} ms | CLIXML ${r.stderr.includes('#< CLIXML')} | ${elements.length} Error element(s), the sentence ${split ? 'split across two of them' : 'whole in one'} | decoded: ${JSON.stringify(decoded)} | undecoded: ${JSON.stringify(undecoded)} | words: ${JSON.stringify(denialWords(streamsShape(r)))} | stderr starts ${JSON.stringify(r.stderr.slice(0, 160))}`)
    expect(treeDigest(f.root), 'the fake root changed').toBe(digestBefore)
    expect(present.filter(t => !existsSync(t)), 'targets gone').toEqual([])
    expect(r.code).not.toBe(0)
    expect(r.stderr.includes('#< CLIXML'), 'the nested PowerShell did not answer in CLIXML').toBe(true)
    expect(decoded, 'the decoded stream names no denial').not.toBeNull()
    // Without the decoder: nothing when the sentence was split, the same words when it was whole in one element.
    expect(undecoded).toBe(split ? null : decoded)
    for (const output of [toolShape(command, r), streamsShape(r)]) {
      const o = liveOutcome({ kind: 'literal', tool: 'Bash', isError: true, output, lost: [], madeInHome: [] })
      expect(o.outcome, o.detail).toBe('denied')
    }
  }, 60_000)

  // T8: Remove-Item's sentence "Access to the path is denied." is cut where the line reaches 119 columns, and where
  // falls with the length of the path before it. Each break point is produced on purpose by padding a file name.
  // G2 (wave 10d): a temp folder too long for the padded paths, or holding white space, makes this a named skip
  // decided at collection (T8_SKIP); the checks inside stay, so a skip that should have fired still fails here.
  it.skipIf(T8_SKIP !== null)(`T8: the Remove-Item sentence broken after each of its first five words reads 'denied'${T8_SKIP ? ` (skipped: ${T8_SKIP})` : ''}`, () => {
    const { pad } = need()
    expect(pad.length, 'the padded folder is not the length the skip was decided on').toBe(tempLength('cynco-real-p-'))
    expect(/\s/.test(pad), `the temp folder's path holds white space, where PowerShell may break the line: ${pad}`).toBe(false)
    const seen = new Map()
    for (let k = 0; k < SENT.length - 1; k += 1) {
      const { lo, hi } = rangeOf(k)
      const s = breakAt(k)
      expect(s, 'the path must stand on its own line').toBeGreaterThan(WRAP - 33 - 1)
      const n = s - 1 - (pad.length + 1)
      expect(n, `the temp folder's path (${pad.length} characters) is too long for a break after '${SENT[k]}' (it needs ${s - 2} at most)`).toBeGreaterThan(0)
      const file = join(pad, `${k}`.padEnd(n, 'x'))
      expect(file.length + 1).toBe(s)
      writeFileSync(file, 'x')
      const command = `Remove-Item -Force -LiteralPath '${file}'`
      assertSafe(command, [pad])
      const r = startLowOk(command)
      const lines = r.stderr.split(/\r?\n/)
      let after = null
      for (let j = 0; j + 1 < lines.length && after === null; j += 1) {
        for (let b = 0; b < SENT.length - 1; b += 1) {
          if (lines[j].trimEnd().endsWith(`: ${SENT.slice(0, b + 1).join(' ')}`) && lines[j + 1].trim() === SENT.slice(b + 1).join(' ')) { after = SENT[b]; break }
        }
      }
      const readings = [toolShape(command, r), streamsShape(r)].map(output => liveOutcome({ kind: 'literal', tool: 'Bash', isError: r.code !== 0, output, lost: existsSync(file) ? [] : [file], madeInHome: [] }))
      console.log(`${TAG} T8 | path+colon ${s} characters (range ${lo}-${hi} for '${SENT[k]}') | exit ${r.code} | ${r.ms} ms | broken after: ${after} | tool shape: ${readings[0].outcome} | stdout+stderr: ${readings[1].outcome} | as written: ${JSON.stringify(lines.slice(0, 3).join('\n'))}`)
      expect(existsSync(file), 'the low child deleted a medium file').toBe(true)
      expect(after, `where the sentence broke: ${JSON.stringify(r.stderr.slice(0, 400))}`).toBe(SENT[k])
      for (const o of readings) expect(o.outcome, o.detail).toBe('denied')
      seen.set(after, s)
    }
    expect([...seen.keys()].sort()).toEqual(['Access', 'is', 'path', 'the', 'to'])
  }, 60_000)
})

// T9 (D8): the engine's real Bash tool at medium integrity, with no run context. A command that prints on both
// streams and exits 0 answers both lines only when it is handed with the trailing merge (F60 under PowerShell; the
// shell's own merge elsewhere); without it the tool hands back `stdout || stderr`, and the second line is missing.
// That premise is asserted too, so the case fails if the tool changes and the merge stops being needed.
describe('the Bash tool and the trailing merge (D8)', () => {
  it('a command that prints OUT-LINE and ERR-LINE and exits 0: both lines with the merge, only the first without', async () => {
    const shell = getShellInfo()
    const command = shell.isPowerShell ? "Write-Output 'OUT-LINE'; [Console]::Error.WriteLine('ERR-LINE')" : 'echo OUT-LINE; echo ERR-LINE 1>&2'
    const merged = await bashTool.execute({ command: withStderrMerged(command) }, tmpdir())
    const plain = await bashTool.execute({ command }, tmpdir())
    console.log(`${TAG} T9 | shell ${shell.shell} | merged: ${JSON.stringify(merged)} | plain: ${JSON.stringify(plain)}`)
    expect(merged.isError).toBe(false)
    expect(merged.output).toContain('OUT-LINE')
    expect(merged.output).toContain('ERR-LINE')
    expect(merged.output.indexOf('OUT-LINE')).toBeLessThan(merged.output.indexOf('ERR-LINE'))
    expect(plain.isError).toBe(false)
    expect(plain.output).toContain('OUT-LINE')
    expect(plain.output, 'the tool now hands back stderr on exit 0 without the merge: D8 may no longer be needed').not.toContain('ERR-LINE')
  }, 60_000)

  // G3 (wave 10d): the exit-0 shape this file reads is the one the tool hands back after E1, checked against the tool
  // itself: a merged command that prints nothing and exits 0 answers '(no output)', not the silent-failure text.
  it("a merged command that prints nothing and exits 0: the tool answers '(no output)', and so does this file's shape", async () => {
    const shell = getShellInfo()
    const command = shell.isPowerShell ? '$null' : 'true'
    const merged = await bashTool.execute({ command: withStderrMerged(command) }, tmpdir())
    console.log(`${TAG} G3 | shell ${shell.shell} | merged: ${JSON.stringify(merged)}`)
    expect(merged.isError).toBe(false)
    expect(merged.output).toBe('(no output)')
    expect(toolShape(command, { code: 0, stdout: '', stderr: '' })).toBe(merged.output)
  }, 60_000)
})

// T4: the guard itself, on texts built to fail it (pure; no process is started).
describe('assertSafe refuses what it must (T4)', () => {
  const root = 'C:\\fixture-root'
  const ctl = 'C:\\low-ctl'
  it('passes a command under the roots, and fails each unsafe one', () => {
    expect(() => assertSafe(`Remove-Item -Force 'C:\\fixture-root\\home\\.cynco'`, [root, ctl])).not.toThrow()
    expect(() => assertSafe(`cmd /c mklink /J "C:\\low-ctl\\s\\out" "C:\\fixture-root\\home"`, [root, ctl])).not.toThrow()
    // cmd's flags open a token with a slash and are not paths; a quoted fixture path with forward slashes is one.
    expect(() => assertSafe(`cmd /c rd /s /q "C:\\fixture-root\\home\\.cynco"`, [root, ctl])).not.toThrow()
    expect(() => assertSafe(`cmd /c 'for /d %d in ("C:\\fixture-root\\home\\*") do rd /s /q "%d"'`, [root, ctl])).not.toThrow()
    // G1: the shape of the catalog's python literals (a lambda's colon, three dots in a text) is not refused. Changed on
    // purpose in wave 18 (plan P6 (12), (14)): the literal's shape since then, onexc or onerror and parameters of more
    // than one letter.
    expect(() => assertSafe(`python -c "import shutil, sys; h = lambda fn, path, info: print('...'); kw = dict(onexc=h) if sys.version_info >= (3, 12) else dict(onerror=h); shutil.rmtree(r'C:\\fixture-root\\x', **kw)"`, [root, ctl])).not.toThrow()
    const bad = [
      `Remove-Item -Force 'C:\\Users\\someone\\.cynco'`,
      `cmd /c mklink /J "C:\\low-ctl\\s\\out" "C:\\Users\\someone"`,
      `Remove-Item -Force 'C:\\fixture-root\\..\\Users\\someone'`,
      `Remove-Item -Force 'C:\\fixture-root-other\\x'`,
      `Remove-Item -Force '\\\\server\\share\\x'`,
      `Remove-Item -Force "$HOME\\.cynco"`,
      `Remove-Item -Force 'D:\\fixture-root\\x'`,
      `Get-ChildItem .`,
      `& 'C:\\Elsewhere\\python.exe' -c "print(1)" 'C:\\fixture-root\\x'`,
      // G1 (wave 10d): each row below also names a path under the root, so only the new rule can refuse it.
      `Copy-Item 'C:\\fixture-root\\x' 'C:Users\\someone\\.cynco'`, // a drive letter with its colon and no separator
      `Copy-Item 'C:\\fixture-root\\x' C:..\\Users`, // the same, climbing
      `Remove-Item -Recurse -Force 'C:\\fixture-root\\x' 'C:'`, // a drive's current folder, quoted
      `Remove-Item -Force 'C:\\fixture-root\\x'; Set-Location C:`, // and at the end of the text
      `Remove-Item -Force 'C:\\fixture-root\\x'; Set-Location ..; Remove-Item -Recurse -Force .cynco`, // '..' outside any drive-letter path
      `Remove-Item -Force 'C:\\fixture-root\\x' '..\\Users\\someone'`,
      `Remove-Item -Force 'C:\\fixture-root\\x' "..\\.."`,
      `Remove-Item -Force 'C:\\fixture-root\\x' "\${env:USERPROFILE}\\.cynco"`,
      `Remove-Item -Force 'C:\\fixture-root\\x' "\${ENV:LocalAppData}"`,
      `Remove-Item -Force 'C:\\fixture-root\\x' ([Environment]::GetEnvironmentVariable('USERPROFILE'))`,
      `Remove-Item -Force 'C:\\fixture-root\\x' ([System.Environment]::GetFolderPath(40))`,
      `Remove-Item -Force 'C:\\fixture-root\\x' (Split-Path $PROFILE)`,
      `Remove-Item -Force 'C:\\fixture-root\\x' (Split-Path $profile.CurrentUserAllHosts)`,
      // After the closing check of wave 10d: the spellings and the root-relative shapes it found passing.
      `Remove-Item -Force 'C:\\fixture-root\\x' "\${HOME}\\.cynco"`,
      `Remove-Item -Force 'C:\\fixture-root\\x' ([System.Environment]::GetEnvironmentVariable('USERPROFILE'))`,
      `Remove-Item -Force 'C:\\fixture-root\\x' ((Get-Item Env:USERPROFILE).Value)`,
      `Remove-Item -Force 'C:\\fixture-root\\x' '\\Users\\someone\\.cynco'`,
      `Remove-Item -Force 'C:\\fixture-root\\x' '/Users/someone/.cynco'`,
      `Remove-Item -Force 'C:\\fixture-root\\x'; Set-Location \\; Remove-Item -Recurse Users\\someone\\.cynco`,
      // Wave 18 (plan P6 (14)): a bare drive followed by white space, and the old literal's one-letter lambda.
      `Remove-Item -Force 'C:\\fixture-root\\x'; Remove-Item C: -Recurse -Force`,
      `Remove-Item -Recurse -Force C: 'C:\\fixture-root\\x'`,
      `Get-ChildItem 'C:\\fixture-root\\x' | Remove-Item -Recurse; Set-Location C: ; Remove-Item -Recurse .cynco`,
      `python -c "import shutil; shutil.rmtree(r'C:\\fixture-root\\x', onerror=lambda f, x, i: print('...'))"`,
    ]
    // Every row is tried, and the ones that got through are named together (was one expect per row, which stopped at
    // the first; the assertion is the same: no row may pass).
    const passed = bad.filter(c => { try { assertSafe(c, [root, ctl]); return true } catch { return false } })
    expect(passed, 'unsafe commands assertSafe let through').toEqual([])
  })
})

// G4 (wave 10d): every cleanup step has its own catch; a throw is recorded and the rest still runs (pure: the file
// system steps are handed in, nothing is touched).
describe('the cleanup runs every step whatever throws (G4)', () => {
  it('records each throw, still removes the other links, lists, resets and roots, and never deletes a root past a link that stayed', () => {
    const calls = []
    const present = new Set(['R1', 'R2', 'R3', 'R4', 'D1', 'D2'])
    const ops = {
      exists: (p) => present.has(p),
      removeLink: (l, failures) => {
        calls.push(`link ${l}`)
        if (l === 'L0') throw new Error('link boom')
        if (l === 'R1\\L1') { failures.push(`the link ${l} could not be removed: busy`); return false }
        return true
      },
      linksIn: (d) => { calls.push(`list ${d}`); if (d === 'R2') throw new Error('list boom'); return d === 'R1' ? ['R1\\L1'] : [] },
      reset: (f) => { calls.push(`reset ${f}`); if (f === 'D1') throw new Error('reset boom') },
      removeRoot: (d) => { calls.push(`root ${d}`); if (d === 'R3') throw new Error('root boom'); present.delete(d) },
    }
    const failures = cleanUp({ links: ['L0', 'L2'], roots: ['R1', 'R2', 'R3', 'R4'], denied: ['D1', 'D2'] }, ops)
    // R1 holds a link that stayed and R2 could not be listed: neither is deleted recursively. R3's removal throws, R4 goes.
    expect(calls).toEqual(['link L0', 'link L2', 'list R1', 'link R1\\L1', 'list R2', 'list R3', 'list R4', 'reset D1', 'reset D2', 'root R3', 'root R4'])
    const has = (re) => expect(failures.some(x => re.test(x)), `${re} in ${JSON.stringify(failures)}`).toBe(true)
    has(/L0.*link boom/)
    has(/the link R1\\L1 could not be removed: busy/)
    has(/R2.*list boom/)
    has(/D1.*reset boom/)
    has(/R3.*root boom/)
    has(/R3 is still there/)
    has(/R1 .*left in place/)
    has(/R2 .*left in place/)
    expect(present.has('R1'), 'a root holding a link that may still be there was deleted recursively').toBe(true)
    expect(present.has('R2'), 'a root that could not be listed for links was deleted recursively').toBe(true)
    expect(present.has('R4')).toBe(false)
  })

  // Wave 18 (plan P6 (14)): a registered link whose first removal failed and which the listing then finds again is the
  // same link, tried a second time; the words say so. A link that was never registered keeps its own words.
  it('a registered link found again after its first removal failed is named as registered and tried again; an unregistered one keeps its words', () => {
    let tries = 0
    const present = new Set(['R1'])
    const ops = {
      exists: (p) => present.has(p),
      removeLink: (l, failures) => {
        if (l === 'R1\\L1' && tries++ === 0) { failures.push(`the link ${l} could not be removed: busy`); return false }
        return true
      },
      linksIn: (d) => (d === 'R1' ? ['R1\\L1', 'R1\\U'] : []),
      reset: () => {},
      removeRoot: (d) => { present.delete(d) },
    }
    const failures = cleanUp({ links: ['R1\\L1'], roots: ['R1'], denied: [] }, ops)
    expect(failures).toContain('the registered link R1\\L1 was still under R1 after its first removal; it is tried again as an entry')
    expect(failures.some(x => /nobody registered.*R1\\L1/.test(x)), JSON.stringify(failures)).toBe(false)
    expect(failures).toContain('a link nobody registered was under R1: R1\\U (removed as an entry)')
    expect(tries).toBe(2)
    // Gone on its second try: the root is removed, not left in place for a link that is no longer there.
    expect(failures.some(x => /R1 is left in place/.test(x)), JSON.stringify(failures)).toBe(false)
    expect(present.has('R1')).toBe(false)
  })
})

// Wave 18 (plan P6 (14)): T8's named skip names the temp folder (pure; no process is started).
describe('T8\'s skip names the temp folder it was decided on', () => {
  it('a temp folder too long for the padded paths: the skip line holds its path and its length', () => {
    const long = `C:\\${'t'.repeat(90)}`
    const why = t8SkipFor(long, true)
    expect(why).toContain(`the temp folder's path ${long} (${long.length} characters) is too long`)
    expect(t8SkipFor('C:\\T', true)).toBeNull()
    expect(t8SkipFor('C:\\a b', true)).toMatch(/holds white space/)
    expect(t8SkipFor('C:\\T', false)).toBe(NOT_WIN)
  })
})
