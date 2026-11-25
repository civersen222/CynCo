import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { ContainmentRefusal, refusalReasonOf, refusalText, toolExec, toolSpawnRefusal } from '../containment.js'
import { harnessGitBin, harnessGitEnv, isHarnessRefused } from '../harnessGit.js'
import { GIT_TIMEOUT_MS } from './worktreeManager.js'
import { toolAudit, containmentFault } from '../audit/toolAudit.js'
import { presenceTripwireConfirmed } from '../integrity.js'
import { ownedExec, ownProcessTree, type OwnedExecEnd } from '../processTree.js'
import { listEntries, type EntryKind } from '../realPath.js'
import type { CandidateResult, TestInfo } from './types.js'
import { parseTestSummary } from '../bridge/testSummary.js'
import { longCommandRefusal } from '../tools/impl/bash.js'

export function selectWinner(candidates: CandidateResult[]): CandidateResult | null {
  const valid = candidates.filter((c) => c.patch.trim().length > 0)
  if (valid.length === 0) return null

  valid.sort((a, b) => {
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    return a.totalTurns - b.totalTurns
  })

  return valid[0]
}

export function parseTestOutput(
  output: string,
  framework: string
): { passed: number; total: number } {
  const summary = parseTestSummary(framework, output)
  return summary ? { passed: summary.passed, total: summary.total } : { passed: 0, total: 0 }
}

/** How long a candidate's tests may run before their process tree is ended. */
export const TEST_RUN_CAP_MS = 120_000

/**
 * Runs a candidate's tests. They are the candidate's own code, so in an unattended run they start
 * through the containment (F242); `refused` is set, and nothing was run, when the run's launcher
 * cannot run, the presence tripwire has confirmed a loss, or the run's audit record could not be
 * written. A refused run is not a score: the caller applies no candidate.
 *
 * Asynchronous since wave 15c (P4(1b), NOW.md:259 for best-of-N): the tree is owned from the moment
 * the root exists and ended on the run's own cap (`capMs`), with a two-second grace, as the contract
 * check's is. The synchronous spawn's timeout ended the shell alone and left what the tests had
 * started running (F201, F210), and it held the event loop the dashboard and the phone are served
 * from for the whole run (F225). A run that ends on its own gives the handle back and kills nothing.
 *
 * `signal` is the turn's Stop (wave 19, check C4-5): it ends the tree at once, as the cap does, and
 * a run asked after it starts nothing (`refused: 'the turn was stopped'`).
 */
export async function runTests(
  cwd: string,
  testInfo: TestInfo,
  capMs: number = TEST_RUN_CAP_MS,
  signal?: AbortSignal,
): Promise<{ passed: number; total: number; output: string; refused?: string }> {
  if (signal?.aborted) return { passed: 0, total: 0, output: '', refused: 'the turn was stopped' }
  // F242 (NOW.md, the bypass sites): the tests start outside the executor, so they ask the
  // presence tripwire themselves; after a loss nothing runs and no candidate is applied.
  const lost = await presenceTripwireConfirmed()
  if (lost) {
    const text = refusalText('integrity', lost)
    toolAudit()?.refused({ src: 'best-of-n', by: 'site', input: { command: testInfo.command }, cwd, layer: 'integrity', reason: text })
    containmentFault('integrity', lost)
    return { passed: 0, total: 0, output: '', refused: text }
  }
  // Wave 19b (`longCommandRefusal`): a command one Windows command line cannot carry made the spawn
  // throw, and one that starts Git's bash or sh with more than about 8,190 characters ran cut short and
  // exited 0, a score for tests that never ran whole. Neither is started; it is no containment fault.
  const tooLong = longCommandRefusal(testInfo.command, testInfo.command)
  if (tooLong) {
    toolAudit()?.refused({ src: 'best-of-n', by: 'site', input: { command: testInfo.command }, cwd, reason: tooLong })
    return { passed: 0, total: 0, output: '', refused: tooLong }
  }
  const refusal = toolSpawnRefusal()
  if (refusal) {
    toolAudit()?.refused({ src: 'best-of-n', by: 'site', input: { command: testInfo.command }, cwd, layer: 'containment', reason: refusal })
    containmentFault('containment', refusalReasonOf(refusal))
    return { passed: 0, total: 0, output: '', refused: refusal }
  }
  // F242: the record of the run is on disk before the candidate's tests start (src best-of-n).
  const audit = toolAudit()
  const started = audit ? audit.start({ src: 'best-of-n', command: testInfo.command, cwd }) : null
  if (started && !started.ok) return { passed: 0, total: 0, output: '', refused: started.reason }
  const t0 = Date.now()
  const refusedAfterStart = (message: string) => {
    if (audit && started) audit.end(started.call, { isError: true, exitCode: null, ms: Date.now() - t0, output: message })
    return { passed: 0, total: 0, output: '', refused: message }
  }
  // The tree is owned from the moment the root exists and ended on the run's own cap, with a
  // two-second grace, and on an output overrun (`ownedExec`, engine/processTree.ts).
  let r: OwnedExecEnd
  try {
    r = await ownedExec(
      callback => toolExec(testInfo.command, { cwd, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }, callback),
      { capMs, own: ownProcessTree, signal, onCut: () => console.log(`[bestOfN] tests cut at their cap of ${capMs} ms; their process tree is ended`) },
    )
  } catch (e) {
    // toolExec throws only before anything starts: its backstop refusal, the long-command file that
    // could not be written, or a spawn that cannot carry its command line (ENAMETOOLONG). Nothing ran, so there is no score. Only a containment refusal is
    // a containment fault (as for LSP, check C4-8).
    const message = (e as Error).message
    if (e instanceof ContainmentRefusal) containmentFault('containment', refusalReasonOf(message))
    return refusedAfterStart(message)
  }
  // A launcher that could not run (exit 197 or 198) reaches the callback as a ContainmentRefusal.
  const fault: unknown = r.err
  if (fault instanceof ContainmentRefusal) {
    containmentFault('containment', refusalReasonOf(fault.message))
    return refusedAfterStart(fault.message)
  }
  // A failing run (tests failed) is parsed as well, and so is what a run cut at its cap or stopped
  // printed; a cut or stopped run has no status of its own (the job's 1 is the kill's).
  if (r.stopped) console.log('[bestOfN] tests stopped with the turn; their process tree is ended')
  const ended = r.timedOut || r.stopped
  const output = r.stdout + r.stderr
  const code = (r.err as { code?: unknown } | null)?.code
  if (audit && started) {
    audit.end(started.call, {
      isError: Boolean(r.err) || ended, exitCode: ended ? null : !r.err ? 0 : typeof code === 'number' ? code : null,
      ms: Date.now() - t0, output,
    })
  }
  const { passed, total } = parseTestOutput(output, testInfo.framework)
  return { passed, total, output }
}
/**
 * Every work-tree path a patch names: both sides of each file it changes, adds, deletes, renames or
 * copies, with git apply's default `-p1` (the first component, `a/` or `b/`, stripped). `why` when a
 * path cannot be read: a quoted name with an escape this does not know, an absolute path, a `..`, or
 * a section that names its file only in a `diff --git` line that cannot be split.
 */
export function patchPaths(patch: string): { paths: string[] } | { why: string } {
  const paths = new Set<string>()
  const unquote = (raw: string): string | null => {
    if (!raw.startsWith('"')) return raw
    if (!raw.endsWith('"') || raw.length < 2) return null
    const bytes: number[] = []
    const body = raw.slice(1, -1)
    const simple: Record<string, number> = { n: 10, t: 9, '"': 34, '\\': 92, a: 7, b: 8, f: 12, r: 13, v: 11 }
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
      const next = body[i + 1]
      if (next === undefined) return null
      if (/[0-7]/.test(next)) {
        const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1))![0]
        bytes.push(parseInt(oct, 8))
        i += oct.length
        continue
      }
      if (!(next in simple)) return null
      bytes.push(simple[next])
      i++
    }
    return Buffer.from(bytes).toString('utf8')
  }
  // `-p1`: the first component goes; what is left is relative to the folder the patch is applied to.
  const strip = (raw: string, prefixed: boolean): string | null => {
    const name = unquote(raw)
    if (name === null) return null
    const rel = prefixed ? name.slice(name.indexOf('/') + 1) : name
    if (prefixed && !name.includes('/')) return null
    return rel
  }
  const add = (rel: string | null, from: string): string | null => {
    if (rel === null) return `its paths could not be read (${from})`
    const parts = rel.split('/')
    if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || parts.some(p => p === '..' || p === '')) {
      return `its paths could not be read (${from}: not a plain path inside the folder)`
    }
    paths.add(rel)
    return null
  }
  let section: { header: string; named: boolean } | null = null
  const endSection = (): string | null => {
    if (section === null || section.named) return null
    // A section with no ---/+++/rename/copy line (a mode change, a binary patch): its file is named
    // only in the header, `diff --git a/P b/P`, which can be split only when both sides are equal.
    const h = section.header
    if (h.startsWith('"')) return `its paths could not be read (${h})`
    const m = /^a\/(.+) b\/(.+)$/.exec(h)
    if (!m || m[1] !== m[2]) return `its paths could not be read (${h})`
    return add(m[1], h)
  }
  // A hunk's lines are content, never names (check C4-1): a removed '-- note' is the hunk line
  // '--- note'. Its body is counted as git apply counts it, from the header's line counts; a hunk
  // whose lines do not add up, or a patch that ends inside one, cannot be read, so every line git
  // would read as a name is still read here.
  let hunk: { old: number; new: number; header: string } | null = null
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (hunk !== null) {
      const c = line[0]
      if (line === '' || c === ' ') { hunk.old--; hunk.new-- }
      else if (c === '-') hunk.old--
      else if (c === '+') hunk.new--
      else if (c !== '\\') return { why: `its paths could not be read (a hunk does not match its header ${hunk.header})` }
      if (hunk.old < 0 || hunk.new < 0) return { why: `its paths could not be read (a hunk does not match its header ${hunk.header})` }
      if (hunk.old === 0 && hunk.new === 0) hunk = null
      continue
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (h) {
      hunk = { old: h[1] === undefined ? 1 : Number(h[1]), new: h[2] === undefined ? 1 : Number(h[2]), header: h[0] }
      if (hunk.old === 0 && hunk.new === 0) hunk = null
      continue
    }
    if (line.startsWith('diff --git ')) {
      const why = endSection()
      if (why) return { why }
      section = { header: line.slice('diff --git '.length), named: false }
      continue
    }
    let raw: string | null = null
    let prefixed = true
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      // A name with a space is ended by a tab in some producers; git quotes a name with a tab.
      raw = line.slice(4).split('\t')[0]
      if (raw === '/dev/null') { if (section) section.named = true; continue }
    } else {
      const m = /^(rename|copy) (from|to) (.+)$/.exec(line)
      if (m) { raw = m[3]; prefixed = false }
    }
    if (raw === null) continue
    if (section) section.named = true
    const why = add(strip(raw, prefixed), line)
    if (why) return { why }
  }
  if (hunk !== null) return { why: `its paths could not be read (a hunk does not match its header ${hunk.header})` }
  const why = endSection()
  if (why) return { why }
  return { paths: [...paths] }
}

/**
 * Why writing `rel` under `root` would go through a link, or null: each component is looked up in
 * its folder's own listing (a low-made junction is a link there, where `lstat` follows it, F242). A
 * link on the way refuses; so does a folder on the way that cannot be listed, and an entry that
 * exists but is not listed under the name given (another case, a short 8.3 name, a trailing dot), a
 * name the listing cannot vouch for. A component that does not exist ends the walk: git makes it.
 */
function linkOnTheWay(root: string, rel: string): string | null {
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s)
  const parts = rel.split('/')
  if (process.platform === 'win32') {
    // Every component first, the ones under a folder that does not exist yet included (git makes
    // them). Windows reads a name that ends in a dot or a space as the name without it, and a
    // backslash as a separator, so `out./x.txt` is written into `out`, which may be a link (check
    // C4-2: git's own refusal of these names is core.protectNTFS, which the repository's config can
    // switch off, measured; and Bun's and Node's existsSync keep the dot and find nothing, measured
    // in wave 19, so the listing check below cannot see it).
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const shown = parts.slice(0, i + 1).join('/')
      if (/[:<>"|?*]/.test(name)) return `it names ${shown}, which is not a plain file name here`
      if (/[. ]$/.test(name) || name.includes('\\')) return `it names ${shown}, which Windows reads as another name`
    }
  }
  let dir = root
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]
    const shown = parts.slice(0, i + 1).join('/')
    let entries: Array<{ name: string; kind: EntryKind }>
    try {
      entries = listEntries(dir)
    } catch (e) {
      return `a folder on its way could not be listed (${parts.slice(0, i).join('/') || '.'}: ${(e as Error).message.split('\n')[0]})`
    }
    const exact = entries.find(e => e.name === name)
    const folded = exact ?? entries.find(e => fold(e.name) === fold(name))
    if (folded === undefined) {
      if (existsSync(join(dir, name))) return `it names ${shown}, which its folder does not list by that name`
      return null
    }
    if (folded.kind === 'link') return `it writes through a link (${shown})`
    if (folded.kind === 'file') return null
    dir = join(dir, folded.name)
  }
  return null
}

/**
 * Applies a winner's patch to the mission folder. `false` when it was not applied, with the reason
 * given to `refused` (the loop's page says it): harness git refused the folder, the patch would
 * write through a link, its paths could not be read, or `git apply --check` refused it.
 */
export function applyPatch(repoRoot: string, patch: string, refused: (why: string) => void = () => {}): boolean {
  if (!patch.trim()) { refused('the patch is empty'); return false }

  const input = Buffer.from(patch)
  // Harness git in a folder a run wrote (F242): no hooks, monitor, repository filters or pager. The
  // refusal is read here, not left to git: harness git refuses by naming a GIT_DIR git cannot open,
  // and `git apply` then runs as it does outside a repository and applies the patch anyway
  // (measured 2026-11-24, wave 15b). It is read by any of its marks (`isHarnessRefused`, wave 19b).
  const env = harnessGitEnv(process.env, { repo: repoRoot })
  if (isHarnessRefused(env)) { refused('harness git refused the folder (the engine log says why)'); return false }
  // The apply writes the work tree, and git takes a junction in it for a folder (F6), so a link on
  // the way to a path the patch writes would put the write wherever the link leads (NOW.md:76). Only
  // those paths are judged (check B4-4): `git apply` writes nothing else, and the whole-tree walk
  // (harnessGitEnv's worktreeLinks) refused honest winners beside an install's links, in any folder
  // of more than 200,000 entries, and cost a walk of the mission folder on the event loop (F225).
  const named = patchPaths(patch)
  if ('why' in named) { refused(named.why); return false }
  for (const rel of named.paths) {
    const why = linkOnTheWay(repoRoot, rel)
    if (why !== null) { refused(why); return false }
  }

  // One argument vector through harnessGitBin under the package's cap (wave 19c, check D19b-6): a git
  // that hangs here (a lock held, a slow volume) held the event loop for good; a cut apply is refused.
  const git = (args: string[]) => execFileSync(harnessGitBin(env), args, {
    cwd: repoRoot,
    env,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  })
  try {
    git(['apply', '--check', '-'])
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '').trim().split(/\r?\n/)[0]
    refused(`git apply --check refused it: ${stderr || (e as Error).message.split('\n')[0]}`)
    return false
  }

  try {
    git(['apply', '-'])
    return true
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '').trim().split(/\r?\n/)[0]
    refused(`git apply failed: ${stderr || (e as Error).message.split('\n')[0]}`)
    return false
  }
}
