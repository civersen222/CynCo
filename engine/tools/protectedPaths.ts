/**
 * engine/tools/protectedPaths.ts: the protected-path check of a contained run (F242, layer 2).
 *
 * Before a tool call runs, `checkProtectedPaths` judges every path it names (`toolPaths.ts`) against
 * the run context (`engine/containment.ts`): a write, delete, move or link outside the mission folder,
 * the run's extra roots and its sandbox is refused, and so is anything inside the always-denied set
 * (the home folder and its dot-entries, CynCo's own folders, other runs' sandboxes, a volume Windows
 * cannot protect), whatever the operation; the audit and guard folders are refused for every
 * operation, reads included. It is exact for the file tools (their target is a field) and a tripwire
 * for shell text, which it reads and can be walked around; the sandbox overlay, the low-integrity
 * token and the integrity manifest are what hold when it misses.
 *
 * With no run context it answers allow at once: interactive sessions, project chats and the test suite
 * are unchanged by it. The verdict is allow, refuse or escalate; escalate behaves as allow and leaves a
 * record (there is no decision model in this change). It reads no environment variable; its one switch
 * is `containmentOff('paths', ctx)`, which only a test context can turn.
 */
import * as nodePath from 'node:path'
import {
  containmentOff, engineCheckout, NO_CONTAINMENT, refusalText, runContainment, type RunContainment,
} from '../containment.js'
import { realPathOf } from '../realPath.js'
import { canonPath, currentHomes, insidePath, namePaths, type NamedCall, type NamedPath } from './toolPaths.js'
import type { HomeMap, PathOp } from './shellPaths.js'

type Platform = 'win32' | 'posix'

export type PathContext = {
  platform: Platform
  missionCwd: string                       // real
  extraRoots: string[]                     // real
  sandbox: { root: string; home: string; tmp: string; scratch: string }   // real
  sandboxParent: string                    // dirname(sandbox.root): the folder all runs' sandboxes share
  home: string                             // real: the REAL home the run is kept out of
  state: string; models: string; guard: string; audit: string | null      // real
  checkout: string                         // real: the checkout this engine runs from
  unprotectedVolumes: string[]             // volume roots, as the context has them
  drives: string[]                         // win32: drive letters of every folder above; [] on posix
  noAccess: string[]                       // [audit, guard], a null audit dropped
  homes: HomeMap                           // currentHomes(ctx)
  isolation: 'verified' | 'overlay'
  real: (p: string) => string
}
export type PathRule = 'no-access' | 'self-building' | 'unreadable' | 'device' | 'unprotected-volume' | 'home'
  | 'home-dot' | 'state' | 'ancestor' | 'git-internals' | 'git-config' | 'link-out' | 'outside' | 'unresolved' | 'unclassified'
export type EscalateNote = { rule: 'root-delete' | 'git-destructive' | 'inline-unread-write'
  reason: string; targets: string[]; recursive: boolean; isolation: 'verified' | 'overlay' }
export type PathVerdict =
  | { kind: 'allow' }
  | { kind: 'refuse'; rule: PathRule | 'containment'; reason: string; text: string; target?: string }
  | { kind: 'escalate'; reason: string; note: EscalateNote }

type ContextResult = { ok: true; pc: PathContext } | { ok: false; fault: string }

const contexts = new WeakMap<RunContainment, ContextResult>()

function hostPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

function pathModule(platform: Platform): typeof nodePath.win32 {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix
}

function driveOf(p: string): string | null {
  const m = p.match(/^([A-Za-z]):/)
  return m ? m[1].toUpperCase() : null
}

function isUnc(p: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(p)
}

function same(a: string, b: string, platform: Platform): boolean {
  return insidePath(a, b, platform) && insidePath(b, a, platform)
}

// ─── The context ───────────────────────────────────────────────────────────────────────────────

/**
 * The run context as the policy judges it: every folder resolved once, the drives the run has a folder
 * on, the home map. A fault (rule R3) instead of a context when a folder of the run is one the policy
 * could not keep it out of. Cached per context object when called without options. Never throws.
 */
export function pathContextOf(ctx: RunContainment, o?: { platform?: Platform; real?: (p: string) => string; checkout?: string })
  : ContextResult {
  if (!o) {
    const hit = contexts.get(ctx)
    if (hit) return hit
  }
  let res: ContextResult
  try {
    res = buildContext(ctx, o ?? {})
  } catch (e) {
    res = { ok: false, fault: `the run context could not be read (${(e as Error)?.message ?? String(e)})` }
  }
  if (!o) contexts.set(ctx, res)
  return res
}

function buildContext(ctx: RunContainment, o: { platform?: Platform; real?: (p: string) => string; checkout?: string }): ContextResult {
  const platform = o.platform ?? hostPlatform()
  const P = pathModule(platform)
  const real0 = o.real ?? ((p: string) => realPathOf(p, { quiet: true }))
  const volumes = ctx.unprotectedVolumes.map(v => canonPath(v, platform))
  const lexical = (c: string) => isUnc(c) || volumes.some(v => insidePath(v, c, platform))
    || (platform === 'posix' && /^[A-Za-z]:/.test(c))
  const R = (p: string): string => {
    const c = canonPath(p, platform)
    return lexical(c) ? c : canonPath(real0(c), platform)
  }
  const fault = (f: string): ContextResult => ({ ok: false, fault: f })

  if (typeof ctx.home !== 'string' || ctx.home === '' || !P.isAbsolute(ctx.home)) return fault('the home folder of this run could not be resolved')
  const home = R(ctx.home)
  const state = R(ctx.folders.state)
  const models = R(ctx.folders.models)
  const guard = R(ctx.folders.guard)
  const audit = ctx.folders.audit === null ? null : R(ctx.folders.audit)
  const checkout = R(o.checkout ?? engineCheckout())
  const missionCwd = R(ctx.missionCwd)
  const extraRoots = ctx.extraRoots.map(R)
  const sandboxRootRaw = ctx.sandbox.root
  const sandbox = { root: R(ctx.sandbox.root), home: R(ctx.sandbox.home), tmp: R(ctx.sandbox.tmp), scratch: R(ctx.sandbox.scratch) }
  const sandboxParent = P.dirname(sandbox.root)
  const inside = (root: string, c: string) => insidePath(root, c, platform)
  const authoring = P.join(state, 'authoring')
  const authoringExempt = (f: string) => inside(authoring, f) && !same(authoring, f, platform)

  const folders: Array<[string, string]> = [[missionCwd, `the mission folder ${missionCwd}`], ...extraRoots.map((r): [string, string] => [r, `the extra folder ${r}`])]
  for (const [f, what] of folders) {
    if (inside(f, home)) return fault(`${what} is the home folder or contains it`)
    if (inside(home, f)) {
      const first = f.slice(home.length).replace(/^[\\/]+/, '').split(/[\\/]/)[0] ?? ''
      if (first.startsWith('.') && !authoringExempt(f)) return fault(`${what} is inside ${first}, a dot-entry of the home folder`)
    }
    const kept: Array<[string | null, string]> = [[models, 'models'], [guard, 'guard'], [audit, 'audit'], [state, 'state'], [sandboxParent, 'sandbox root']]
    for (const [k, name] of kept) {
      if (k === null) continue
      if (!(inside(k, f) || inside(f, k))) continue
      if (name === 'state' && authoringExempt(f)) continue
      return fault(`${what} is, contains or is inside a folder CynCo keeps for itself (${name})`)
    }
    if (P.parse(f).root === f || isUnc(f) || volumes.some(v => inside(v, f)) || (platform === 'posix' && /^[A-Za-z]:/.test(f))) {
      return fault(`${what} is a volume root, a network share or on a volume Windows cannot protect`)
    }
    if (inside(f, checkout) || inside(checkout, f)) return fault(`${what} is, contains or is inside the checkout this engine runs from (${checkout})`)
  }

  const sb = sandbox.root
  const sbFault = (why: string) => fault(`the sandbox of this run (${sb}) is ${why}`)
  if (!P.isAbsolute(sandboxRootRaw)) return sbFault('not an absolute path')
  if (inside(home, sb)) return sbFault('the home folder or inside it')
  if (inside(sb, home)) return sbFault('a folder that contains the home folder')
  for (const k of [state, models, guard, audit]) {
    if (k !== null && (inside(k, sb) || inside(sb, k))) return sbFault('inside or around a folder CynCo keeps for itself')
  }
  if (isUnc(sb) || volumes.some(v => inside(v, sb)) || (platform === 'posix' && /^[A-Za-z]:/.test(sb))) return sbFault('a network share or on a volume Windows cannot protect')
  for (const k of ['home', 'tmp', 'scratch'] as const) {
    if (!inside(sb, sandbox[k]) || same(sb, sandbox[k], platform)) return fault(`the sandbox of this run is malformed: its ${k} folder is not inside ${sb}`)
  }

  const drives = platform === 'win32'
    ? [...new Set([missionCwd, ...extraRoots, sandbox.root, sandbox.home, sandbox.tmp, sandbox.scratch, home, state, models, guard, audit, checkout]
      .filter((p): p is string => p !== null).map(driveOf).filter((d): d is string => d !== null))]
    : []
  const pc: PathContext = {
    platform, missionCwd, extraRoots, sandbox, sandboxParent, home, state, models, guard, audit, checkout,
    unprotectedVolumes: volumes, drives,
    noAccess: [audit, guard].filter((p): p is string => p !== null),
    homes: currentHomes(ctx),
    isolation: ctx.isolation,
    real: real0,
  }
  return { ok: true, pc }
}

// ─── judgePath ─────────────────────────────────────────────────────────────────────────────────

const WRITE_CLASS = new Set<PathOp>(['write', 'delete', 'move', 'link'])

/**
 * The always-denied set and the roots, for one real path and one operation. Pure: no I/O, no
 * environment, no clock. First match wins (section 3.3 of the specification).
 */
export function judgePath(real: string, op: PathOp, pc: PathContext, source: 'field' | 'shell' = 'shell')
  : { allow: true } | { allow: false; rule: PathRule; detail: string } {
  const p = pc.platform
  const inside = (root: string) => insidePath(root, real, p)
  const no = (rule: PathRule, detail = '') => ({ allow: false as const, rule, detail })
  // 1. The audit and guard folders: every operation.
  if (pc.noAccess.some(inside)) return no('no-access')
  // 2. Reads.
  if (op === 'read' || op === 'list' || op === 'cd' || op === 'mention') return { allow: true }
  // 3. The mission folder and the extra roots.
  for (const root of [pc.missionCwd, ...pc.extraRoots]) {
    if (!inside(root)) continue
    if (source === 'field' && insidePath(pathModule(p).join(root, '.git'), real, p)) return no('git-internals')
    return { allow: true }
  }
  // 4. The run's own sandbox.
  if (inside(pc.sandbox.home) || inside(pc.sandbox.tmp) || inside(pc.sandbox.scratch)) return { allow: true }
  if (inside(pc.sandbox.root)) return WRITE_CLASS.has(op) ? no('state', "this run's own containment record") : { allow: true }
  // 5. A volume nothing protects, judged lexically.
  if (isUnc(real)) return no('unprotected-volume', 'a network share')
  const vol = pc.unprotectedVolumes.find(v => inside(v))
  if (vol) return no('unprotected-volume', `a volume Windows cannot protect (${vol})`)
  if (p === 'win32') {
    const d = driveOf(real)
    if (d !== null && !pc.drives.includes(d)) return no('unprotected-volume', `a drive this run has no folder on (${d}:)`)
  } else if (/^[A-Za-z]:/.test(real)) return no('unprotected-volume', 'a drive this system does not have')
  // 6. The home folder itself, and a folder around a protected one.
  if (same(real, pc.home, p)) return no('home')
  const kept = [pc.home, pc.state, pc.models, pc.guard, pc.audit, pc.sandboxParent, ...pc.unprotectedVolumes]
  if (kept.some(k => k !== null && insidePath(real, k, p) && !same(real, k, p))) return no('ancestor')
  // 7. A dot-entry of the home folder.
  if (inside(pc.home)) {
    const first = real.slice(pc.home.length).replace(/^[\\/]+/, '').split(/[\\/]/)[0] ?? ''
    if (first.startsWith('.')) return no('home-dot', first)
  }
  // 8. CynCo's own folders and other runs' sandboxes.
  if ([pc.state, pc.models, pc.guard, pc.audit].some(k => k !== null && inside(k))) return no('state', 'a folder CynCo keeps for itself')
  if (inside(pc.sandboxParent)) return no('state', "another run's sandbox")
  // 9. A script or a program operand outside the always-denied set (finding 2.B1).
  if (op === 'unclassified' || op === 'exec') return { allow: true }
  // 10. The checkout this engine runs from: write-class only.
  if (inside(pc.checkout)) return no('state', 'the checkout this engine runs from')
  // 11.
  return no('outside')
}

// ─── Refusal texts (rule R9) ──────────────────────────────────────────────────────────────────

const PRECEDENCE: Array<PathRule | 'containment'> = ['containment', 'no-access', 'self-building', 'unreadable', 'device',
  'unprotected-volume', 'home', 'home-dot', 'state', 'ancestor', 'git-internals', 'git-config', 'link-out', 'outside',
  'unresolved', 'unclassified']

const OP_TEXT: Partial<Record<PathOp, string>> = { write: 'write to', delete: 'delete', move: 'move', link: 'create a link at', exec: 'run', unclassified: 'hand a program' }
const OP_VERB: Record<'write' | 'delete' | 'move' | 'link', string> = { write: 'writes', delete: 'deletes', move: 'moves', link: 'links' }

const CATEGORY: Partial<Record<PathRule, string>> = {
  home: 'the home folder',
  'home-dot': 'a dot-entry of the home folder',
  state: 'a folder CynCo keeps for itself',
  ancestor: 'a folder that contains the home folder or a protected folder',
  'unprotected-volume': 'a volume Windows cannot protect',
  outside: 'outside the mission folder and the scratch folder',
  'git-internals': "inside the repository's .git folder",
  'no-access': 'a folder this run may not read, list or change',
}

const HINT: Partial<Record<PathRule, string>> = {
  'git-internals': "Git's own files are changed only by git itself: use the Git tool or a git command.",
  'git-config': 'In an unattended run only user.name and user.email may be set. Commits still work, and so does git -c user.name=... -c user.email=... commit.',
  unresolved: 'The check reads the command as text and cannot tell where that mutation lands. If the two are unrelated, run them as separate calls and spell the target literally.',
  unclassified: 'The check cannot tell what that program does with it. If the command only reads it, read it with Read, Grep or Get-Content instead; to use a file from it, copy it into the mission folder first with Copy-Item.',
  'self-building': 'The check reads the command as text and cannot read text the command builds or decodes. Write the command out plainly.',
  unreadable: 'Write long content to a file with the Write tool, and run a long program from a file in the mission folder.',
}

/** What the model is told after a volume, disk, partition, shadow-copy or backup operation. */
const DEVICE_HINT = 'An unattended run never formats, partitions, wipes or relabels a volume, and never deletes shadow copies or backups (a shadow copy is how lost files are restored). If the mission needs one, say in your reply what and why; the owner does it by hand.'

/** The hint for a path found inside an inline program (`python -c`, `node -e`, a here-document fed to one). */
const INLINE_HINT = 'The check reads an inline program as text and does not know what this call does with that path. If the program only reads it, write the program to a file in the mission folder with the Write tool and run that file (python <file>, node <file>).'

/** A path the scan found inside an inline program rather than as a shell word. */
function fromInlineProgram(n: NamedPath): boolean {
  return /shell>(?:[\w.-]*(?:python|py|pypy|node|nodejs|tsx|ts-node|bun|deno|ruby|perl|php|lua|rscript)[\w.]*\s(?:-|eval)|[^>]*(?:heredoc|stdin))/i.test(n.via)
}

/**
 * Rules whose refusal names a target the scan read literally: there, another spelling of the same command
 * is refused the same way, and the text says so. A guessed operand, an unread mutation, a built command or
 * an unreadable call can be honest work, and the text says what to do instead.
 */
const NO_RETRY = new Set<PathRule>(['no-access', 'device', 'unprotected-volume', 'home', 'home-dot', 'state', 'ancestor',
  'git-internals', 'git-config', 'link-out', 'outside'])

function normText(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

function shown(raw: string, real: string): string {
  const r = raw.trim()
  if (r === '') return real
  const bare = r.replace(/^["']|["']$/g, '')
  return normText(bare) === normText(real) ? r : `${r} (which resolves to ${real})`
}

function advice(pc: PathContext, hint: string | undefined, retry = false): string {
  const also = pc.extraRoots.length ? `, the folders handed to this run (${pc.extraRoots.join(', ')})` : ''
  const close = retry
    ? 'Do not retry with another spelling: do the work inside those folders, or say in your reply what you need and why.'
    : 'Do the work inside those folders, or say in your reply what you need and why.'
  const para = `In this run you may create, change, move and delete files only inside the mission folder (${pc.missionCwd})${also} and the scratch folder (${pc.sandbox.scratch}; the shell has it as CYNCO_SCRATCH). Reading elsewhere is allowed, and a file you need from elsewhere can be copied into the mission folder with Copy-Item. Programs you start already see an empty throwaway home, cache and temp folder of their own, so there is nothing to clear. A brief's description of a test environment (an empty cache, an empty user-files folder) describes the grader's own throwaway folders and is never reproduced on this machine. ${close}`
  return `Nothing was run.${hint ? ` ${hint}` : ''}\n\n${para}`
}

function refusal(pc: PathContext, rule: PathRule, reason: string, target?: string, hint: string | undefined = HINT[rule],
  noRetry: boolean = NO_RETRY.has(rule)): PathVerdict {
  const text = refusalText('protected path', reason, advice(pc, hint, noRetry))
  const v: PathVerdict = { kind: 'refuse', rule, reason, text }
  if (target !== undefined && rule !== 'no-access') v.target = target
  return guardNoAccess(pc, v)
}

const NO_ACCESS_REASON = 'this call names a folder this run may not read, list or change'

/** A refusal text never carries the audit or guard folder: one that would is replaced by the no-access refusal. */
function guardNoAccess(pc: PathContext, v: PathVerdict): PathVerdict {
  if (v.kind !== 'refuse') return v
  const t = normText(v.text)
  if (pc.noAccess.some(n => t.includes(normText(n)))) {
    return { kind: 'refuse', rule: 'no-access', reason: NO_ACCESS_REASON, text: refusalText('protected path', NO_ACCESS_REASON, advice(pc, undefined, true)) }
  }
  return v
}

// ─── judgeCall ─────────────────────────────────────────────────────────────────────────────────

type Candidate = { rule: PathRule; order: number; make: () => PathVerdict }

/**
 * Rules R5 to R11 for one named call: the one place every refusal text is built. Exported so the attack
 * table can be judged under a win32 context with no disk (finding 2.M4).
 */
export function judgeCall(toolName: string, named: NamedCall, pc: PathContext, toolCwd: string): PathVerdict {
  const cands: Candidate[] = []
  const add = (rule: PathRule, order: number, reason: () => string, target?: string, hint?: string, noRetry?: boolean) =>
    cands.push({ rule, order, make: () => refusal(pc, rule, reason(), target, hint ?? HINT[rule], noRetry ?? NO_RETRY.has(rule)) })
  const scan = named.scan
  const realOf = (n: NamedPath): string => n.real()

  // Whole-call refusals (R2, R7).
  if (named.faults.length) add('unreadable', 0, () => `the path check could not read this call (${named.faults[0]}), and an unattended run does not run what it cannot read`)
  if (scan?.truncated && scan.sawWrite) add('unreadable', 0, () => `the path check could not read this call (${scan.truncated}), and an unattended run does not run what it cannot read`)
  if (scan?.selfBuilding) add('self-building', 0, () => `this command builds or decodes the text it runs (${scan.selfBuilding}), so what it touches cannot be read before it runs`)
  if (scan?.gitConfigWrite) add('git-config', 0, () => `this command would change the git setting ${scan.gitConfigWrite}`)
  const protectedSpellings = [...pc.noAccess]
  const words = [...named.texts, ...named.spellings].map(normText)
  if (protectedSpellings.some(f => words.some(w => w.includes(normText(f))))) add('no-access', 0, () => NO_ACCESS_REASON)

  named.paths.forEach((n, i) => {
    const order = i + 1
    // A volume, disk, partition, shadow-copy or backup operation (policy item 5 of the sixth review): no
    // rewrite in a run makes it safe, and the text names what the owner can do instead.
    if (n.deviceOp) { add('device', order, () => `this command ${n.deviceOp}`, undefined, DEVICE_HINT, false); return }
    if (n.device) { add('device', order, () => `${n.raw} is a device or volume path`); return }
    const real = realOf(n)
    if (n.source === 'field' && n.op !== 'link') {
      const j = judgePath(real, n.op, pc, 'field')
      if (!j.allow) add(j.rule, order, () => reasonFor(j.rule, j.detail, n, real), real)
      return
    }
    if (n.op === 'mention') {
      const j = judgePath(real, 'mention', pc)
      if (!j.allow) add(j.rule, order, () => NO_ACCESS_REASON)
      return
    }
    // A link, from the shell or a patch that makes one (R6): both ends inside the roots.
    if (n.op === 'link') {
      const j = judgePath(real, 'link', pc, n.source)
      if (!j.allow && j.rule === 'no-access') { add('no-access', order, () => NO_ACCESS_REASON); return }
      if (n.linkTarget === null || n.linkTarget === undefined) {
        add('link-out', order, () => 'this call would create a link whose two ends cannot both be read from the command', real)
        return
      }
      const t = canonPath(n.linkTarget, pc.platform)
      const tReal = isRootish(t, pc) ? t : canonPath(pc.real(t), pc.platform)
      if (judgePath(tReal, 'read', pc).allow === false) { add('no-access', order, () => NO_ACCESS_REASON); return }
      if (!j.allow) { add(j.rule, order, () => reasonFor(j.rule, j.detail, n, real), real); return }
      if (!insideRoots(tReal, pc)) add('link-out', order, () => `this call would create a link at ${shown(n.raw, real)} that points to ${tReal}, outside the mission folder and the scratch folder`, real)
      return
    }
    if (n.op === 'exec' || n.op === 'unclassified') {
      const j = judgePath(real, n.op, pc)
      if (j.allow) return
      // RS4 (review 2026-11-23, fourth): the folder a program, a script, an interpreter or git starts in is
      // where its relative writes land, so it is judged on the always-denied set like any operand handed to
      // a program (`cd D:\; python clean.py`, `cd ~; git clean -fdx`). Measured cost: 0 of 3,342 past calls.
      if (n.startedIn) {
        const cat = CATEGORY[j.rule] ?? j.rule
        const rule: PathRule = j.rule === 'no-access' || j.rule === 'unprotected-volume' ? j.rule : 'unclassified'
        add(rule, order, () => `this command starts ${n.verb ?? 'a program'} in ${shown(n.raw, real)} (${cat}), where what it writes cannot be read from the command`, real,
          'Start programs from the mission folder (Set-Location back to it first, or name it with Push-Location / -WorkingDirectory), and hand them any other folder as an operand.', false)
        return
      }
      const inline = fromInlineProgram(n) ? INLINE_HINT : undefined
      // A volume nothing protects is refused whatever the program does with it: the inline hint is not given
      // there. The operand was guessed, not read as a target, so the text does not forbid a retry (the
      // retry advice follows the operation, not the rule: review 2026-11-23, third).
      if (j.rule === 'no-access') { add(j.rule, order, () => reasonFor(j.rule, j.detail, n, real), real); return }
      if (j.rule === 'unprotected-volume') { add(j.rule, order, () => reasonFor(j.rule, j.detail, n, real), real, undefined, false); return }
      const cat = CATEGORY[j.rule] ?? j.rule
      add('unclassified', order, () => n.op === 'exec'
        ? `this command would run the script ${shown(n.raw, real)} (${cat})`
        : `this command hands ${shown(n.raw, real)} (${cat}) to a program whose effect on it cannot be read from the command`, real, inline)
      return
    }
    const j = judgePath(real, n.op, pc)
    if (!j.allow) add(j.rule, order, () => reasonFor(j.rule, j.detail, n, real), real)
  })

  // R5.5: an unresolved mutation.
  const um = scan?.unresolvedMutation ?? null
  if (um) {
    const denied = new Set<PathRule>(['home', 'home-dot', 'state', 'ancestor', 'unprotected-volume'])
    const severe = um.op === 'delete' || um.op === 'move'
    named.paths.forEach((n, i) => {
      if (n.source !== 'shell' || n.device) return
      const real = realOf(n)
      const j = judgePath(real, um.op, pc)
      if (j.allow) return
      const hit = denied.has(j.rule) || (severe && j.rule === 'outside' && (n.op === 'mention' || n.op === 'unclassified'))
      if (!hit) return
      const cat = CATEGORY[j.rule] ?? j.rule
      add('unresolved', i + 1, () => `this command names ${shown(n.raw, real)} (${cat}) and also ${OP_VERB[um.op]} through a variable, a pipeline or a computed path that cannot be read before it runs`, real,
        fromInlineProgram(n) ? INLINE_HINT : undefined)
    })
    // An inline program's own unread write is escalated, not walked up (review 2026-11-24, eighth, C1): a climb
    // token anywhere in its text (`.parent` of a literal, `dirname` in a print) names no place, and the walk gave a
    // false reason for a readable target. A delete or a move is still walked.
    if (scan && scan.parentClimb > 0 && !(um.code === true && um.op === 'write')) {
      const P = pathModule(pc.platform)
      let cur = canonPath(toolCwd, pc.platform)
      for (let k = 0; k < Math.min(scan.parentClimb, 16); k++) {
        const up = P.dirname(cur)
        if (up === cur) break
        cur = up
        const j = judgePath(cur, um.op, pc)
        if (j.allow) continue
        if (!severe && !denied.has(j.rule)) continue
        const anc = cur
        const cat = CATEGORY[j.rule] ?? j.rule
        add('unresolved', named.paths.length + 1 + k, () => `this command ${OP_VERB[um.op]} through a computed path that climbs out of the working folder, and ${anc} (${cat}) is where that leads`, anc)
        break
      }
    }
  }

  // The default-deny rules of the fourth review (each one below, with what it refuses, why, what the model
  // is told to write instead and how to relax it).
  const late = named.paths.length + 64
  refuseUnreadTarget(named, pc, add, late)
  refuseRedirectedAnchor(named, add, late)
  refuseUnreadFolder(named, add, late)
  refuseUnreadOperand(named, add, late)
  refuseUnprotectedVolume(toolName, named, pc, add, late)

  if (cands.length) {
    cands.sort((a, b) => (PRECEDENCE.indexOf(a.rule) - PRECEDENCE.indexOf(b.rule)) || (a.order - b.order))
    return cands[0].make()
  }
  return escalation(toolName, named, pc)
}

// ─── Default deny for what the scan cannot read (review 2026-11-23, fourth) ───────────────────
//
// Until the fourth review a mutation whose target the scan could not read was refused only beside a
// protected spelling, and escalated (allowed, with a log line) when it was recursive. Three review rounds
// that day found 178, 50 and 47 walk-arounds, most of them that shape, on drives where the check is the only
// layer (D:, exFAT, FAT, shares). Each rule below turns one unread case into a refusal. The cost of each was
// measured on the 3,342 Bash calls of past runs (the session journals): the numbers are in the report of the
// fourth review and in `engine/tools/CLAUDE.md`. To relax one, delete its call in `judgeCall`; nothing else
// depends on it.

type AddCandidate = (rule: PathRule, order: number, reason: () => string, target?: string, hint?: string, noRetry?: boolean) => void

/**
 * What the model is told to write instead of a target the check cannot read, in the shell it wrote (review
 * 2026-11-24, seventh, rule 4): the literal form, one call per target, a listing of a literal folder for what a
 * listing finds, a literal path under the scratch folder for temporary work (the brief's own rule), the Write tool
 * for content. It never says "do not retry": every one of these forms passes.
 */
const UNREAD_HINTS: Record<'ps' | 'cmd' | 'posix', string> = {
  ps: 'The check runs only what it can read. Spell each target as a literal path relative to the mission folder (Remove-Item -Recurse -Force .\\build), one call per target; to remove what a listing finds, pipe a listing of a literal folder straight into the command (Get-ChildItem .\\build -Filter *.pyc | Remove-Item); to rename what a listing finds, give Rename-Item a new name only (Get-ChildItem .\\out\\*.log | Rename-Item -NewName { $_.Name -replace \'\\.log$\', \'.old\' }); for temporary work use a literal path under the scratch folder ("$env:CYNCO_SCRATCH\\work"); to write content to a file use the Write tool.',
  cmd: 'The check runs only what it can read. Spell each target as a literal path relative to the mission folder (rd /s /q build), one call per target; to remove what a listing finds, name a literal folder and pattern (del /s /q build\\*.pyc); for temporary work use a literal path under the scratch folder (%CYNCO_SCRATCH%\\work); to write content to a file use the Write tool.',
  posix: 'The check runs only what it can read. Spell each target as a literal path relative to the mission folder (rm -rf ./build), one call per target; to remove what a listing finds, give find a literal folder (find ./build -name \'*.pyc\' -delete); for temporary work use a literal path under the scratch folder ("$CYNCO_SCRATCH/work"); to write content to a file use the Write tool.',
}

function unreadHint(dialect: 'ps' | 'cmd' | 'posix' | null): string {
  return UNREAD_HINTS[dialect ?? 'ps']
}

/**
 * RS1. Refuses a call whose scan found a write, delete, move or link through a target it could not read
 * (a variable, a pipeline element that changes its items, a computed path, a subexpression, an unknown
 * parameter), whatever the operation and whether or not it is recursive. The model is told the literal form
 * in the dialect it wrote (`unreadHint`, or the inline program's hint).
 *
 * Except (review 2026-11-24, sixth, policy item 3): a WRITE made by a call inside an inline program (`python
 * -c`, `node -e`, a here-document fed to one), where computed targets are the norm, is escalated (it runs and
 * is recorded: `inlineUnreadWrite`) unless the same call also names a protected place or a volume nothing
 * protects. A delete, a move or a link through an unread target stays refused. To relax it further, drop the
 * `um.op === 'write'` test; to undo it, delete the `inlineUnreadWrite` return.
 */
function refuseUnreadTarget(named: NamedCall, pc: PathContext, add: AddCandidate, order: number): void {
  const um = named.scan?.unresolvedMutation
  if (!um) return
  if (inlineUnreadWrite(named, pc)) return
  // A call of an inline program's code (`fs.writeFileSync`, `shutil.rmtree`) gets the program's hint, not the shell's (review of wave 5).
  const code = /\.[A-Za-z_]/.test(um.verb)
  add('unresolved', order, () => `this command ${OP_VERB[um.op]} through a target that cannot be read before it runs (${um.verb})`, undefined,
    code ? `${INLINE_HINT} Or call it with a literal target relative to the mission folder.` : unreadHint(named.scan?.unreadDialect ?? null))
}

/** An unread write that only an inline program's own calls made, in a call that names no protected place. */
function inlineUnreadWrite(named: NamedCall, pc: PathContext): boolean {
  const um = named.scan?.unresolvedMutation
  if (!um || um.code !== true || um.op !== 'write') return false
  const denied = new Set<PathRule>(['no-access', 'home', 'home-dot', 'state', 'ancestor', 'unprotected-volume'])
  return !named.paths.some(n => {
    if (n.source !== 'shell' || n.startedIn) return false
    const j = judgePath(n.real(), 'write', pc)
    return !j.allow && denied.has(j.rule)
  })
}

/**
 * RS3. Refuses a write-class target spelled through a temp or scratch folder (`[IO.Path]::GetTempPath()`,
 * `tempfile.gettempdir()`, `os.tmpdir()`) when the same command points one of those names somewhere the scan
 * cannot vouch for (`ShellScan.tempRedirected`): the spelling then names wherever the assignment pointed it, not
 * the sandbox's folder. Since the seventh review (2026-11-24, policy item 4) the scan reads the assignment by
 * dialect (`$env:TEMP =`, POSIX `TMPDIR=` and `export`, cmd `set TMP=`, `os.environ['TMP'] =`, an env: item whose
 * operand is a temp name) and judges its value: one that stays in this run's folders (a temp or scratch spelling,
 * `$(mktemp -d)`, the working folder, a relative path that does not climb) is bound, so the later spellings are
 * judged where they land and nothing is reported; one elsewhere or unread is reported. `$tmp`, POSIX `tmp` and
 * `Remove-Item Env:NODE_ENV` set no temp name. Also a write-class target spelled through the working folder
 * (`$PWD`, `Get-Location`, `os.getcwd()`) after a folder change the scan could not follow. The model is told to
 * point the name at a folder inside the scratch folder or the mission folder. To relax it, delete its call in
 * `judgeCall`. Measured cost: 0 of 3,342 past calls.
 */
function refuseRedirectedAnchor(named: NamedCall, add: AddCandidate, order: number): void {
  const scan = named.scan
  if (!scan) return
  const mut = (n: NamedPath) => n.source === 'shell' && WRITE_CLASS.has(n.op)
  const temp = scan.tempRedirected !== null ? named.paths.find(n => mut(n) && (n.anchor === 'temp' || n.anchor === 'scratch')) : undefined
  if (temp) {
    add('unresolved', order, () => `this command sets ${scan.tempRedirected} and then ${OP_VERB[temp.op as 'write']} through a temp or scratch folder, which then may not be this run's own`, undefined,
      'A temp name may be pointed at a folder inside the scratch folder or the mission folder ($env:TEMP = "$env:CYNCO_SCRATCH\\t", TMPDIR=$(mktemp -d)); a value elsewhere, or one the check cannot read, is refused. Otherwise use the scratch folder by its full path.')
  }
  const stale = named.paths.find(n => mut(n) && n.staleBase)
  if (stale) {
    add('unresolved', order, () => `this command ${OP_VERB[stale.op as 'write']} through the working folder after a change of folder that cannot be read before it runs`, undefined, unreadHint(scan.unreadDialect))
  }
}

/**
 * RS4 (its unread half; the folder a program starts in is judged with the other paths, `startedIn`).
 * Refuses a call that starts a program, a script, an interpreter or git in a folder the scan cannot read
 * (after a `cd` to a computed folder, or a `cwd=` it cannot evaluate). Measured cost: 1 of 3,342 past calls
 * (`cwd='.' if False else '.'`, rewritten `cwd='.'`).
 */
function refuseUnreadFolder(named: NamedCall, add: AddCandidate, order: number): void {
  const f = named.scan?.unreadFolder
  if (!f) return
  add('unresolved', order, () => `this command starts ${f.verb} in a folder that cannot be read before it runs`, undefined,
    'Change folder with a literal path (Set-Location .\\sub, or cwd=\'sub\' in code), or start the program from the mission folder with the folder as a literal operand.')
}

/**
 * T6c. Refuses a call that hands a program the tables do not know an operand the scan cannot read (`sdelete
 * $t`, `ffmpeg -i in.mp4 $t`): what the program does with it cannot be read. Keywords, expressions and the
 * cmdlets that read, filter, format or wait are not programs here (`NOT_A_PROGRAM`, `shellPaths.ts`);
 * interpreters' script arguments are not judged by this rule. Measured cost: 0 of 3,342 past calls.
 */
function refuseUnreadOperand(named: NamedCall, add: AddCandidate, order: number): void {
  const o = named.scan?.unreadOperand
  if (!o) return
  add('unresolved', order, () => `this command hands ${o.verb} an operand that cannot be read before it runs`, undefined,
    'Spell what the program is handed as a literal path relative to the mission folder, one call per target, or write the program\'s work as a script in the mission folder and run that file.')
}

/** msys's and WSL's spelling of a drive in a call's text (`/d/DCIM`, `/mnt/d/`). */
const MSYS_SPELLING = /(?<![\w./\\-])\/(?:mnt\/)?([A-Za-z])\/(?![\/])/g

/** The drive letters and shares a call's text spells, for RS2. */
const VOLUME_SPELLINGS = [
  /(?<![A-Za-z0-9])([A-Za-z]):[\\/*?]/g,
  /\bGet-PSDrive\s+(?:-Name\s+|-LiteralName\s+)?['"]?([A-Za-z])['"]?(?![\w:])/gi,
  /['"]([A-Za-z])['"]\s*[,+]\s*['"]:[\\/]/g,
  // A bare drive in quotes, as WMI and CIM filters spell it (`DriveLetter='D:'`, review 2026-11-24, seventh); a
  // quoted `'x:'` anywhere else is a label, not a drive.
  /\b(?:DriveLetter|DeviceID|VolumeName|Name|Caption)\s*=\s*\\?['"]([A-Za-z]):\\?['"]/gi,
]

/**
 * RS2. Refuses a Bash call that names a volume Windows cannot protect (an unprotected volume of the context,
 * a network share, a drive the run has no folder on), by any path the scan found, a mention included, or by
 * a drive letter spelled in its text, unless the call only reads: no write-class operation, no program
 * started, no unresolved mutation, nothing self-building. On such a volume the check is the only layer, and
 * most walk-arounds of the three rounds spelled the volume somewhere in the call. Measured cost: 0 of 3,342
 * past calls. The model is told that a call that only reads there is allowed, and the reason says what the call
 * does there (a write, or a program whose effect cannot be read: seventh review). The text net for a drive letter
 * is switched off only by a real read or listing on that drive, never by a mention (an assignment's value), where a
 * misread binding hides a delete (seventh review, P12). To relax it, delete its call in `judgeCall`.
 */
function refuseUnprotectedVolume(toolName: string, named: NamedCall, pc: PathContext, add: AddCandidate, order: number): void {
  const scan = named.scan
  if (toolName !== 'Bash' || scan === null) return
  const onlyReads = !scan.sawWrite && !scan.ranProgram && scan.unresolvedMutation === null && scan.selfBuilding === null
    && named.paths.every(n => !WRITE_CLASS.has(n.op) && n.op !== 'exec' && n.op !== 'unclassified')
  if (onlyReads) return
  const hint = 'A volume Windows cannot protect (a removable or camera drive, a drive this run has no folder on, a network share) is read-only to an unattended run: a call that only reads there (Get-ChildItem, Get-Content) is allowed, and one that also writes, deletes, moves, runs a program or computes a path is refused, because there this check is the only protection.'
  const foreign = (c: string): string | null => {
    if (isUnc(c)) return 'a network share'
    const vol = pc.unprotectedVolumes.find(v => insidePath(v, c, pc.platform))
    if (vol) return `a volume Windows cannot protect (${vol})`
    const d = pc.platform === 'win32' ? driveOf(c) : null
    return d !== null && !pc.drives.includes(d) ? `a drive this run has no folder on (${d}:)` : null
  }
  // Only in a call that starts no program and has no part it cannot read: there a copy off the volume is the
  // copy verb's own read; beside a program, what the program does there cannot be read (round 4's RS2 stands).
  const unread = scan.unresolvedMutation !== null || scan.selfBuilding !== null || scan.ranProgram
  // The text net below is switched off for a drive only by a real read or listing there, never by a mention (an
  // assignment's value, a list's element): a mention is where a misread binding hides a delete (review
  // 2026-11-24, seventh, P12). A mention still does not refuse by itself.
  const readOnly = (n: NamedPath) => !unread && (n.op === 'read' || n.op === 'list' || n.op === 'mention')
  const readDrives = new Set<string>()
  // The reason says what the call does: a write-class operation there, or a program started beside it.
  const doing = (n: NamedPath) => (WRITE_CLASS.has(n.op) ? 'and does more than read it'
    : 'and starts a program or does something else whose effect there cannot be read from the command')
  for (const n of named.paths) {
    if (n.source !== 'shell') continue
    const c = canonPath(n.path, pc.platform)
    const detail = foreign(c)
    if (detail === null) continue
    if (readOnly(n)) { const d = driveOf(c); if (d !== null && n.op !== 'mention') readDrives.add(d); continue }
    add('unprotected-volume', order, () => `this command names ${shown(n.raw, c)}, on ${detail}, ${doing(n)}`, c, hint, false); return
  }
  const textReason = unread && !scan.sawWrite ? 'and starts a program or does something else whose effect there cannot be read from the command' : 'and does more than read it'
  if (pc.platform !== 'win32') return
  // msys's and WSL's spellings (`/d/`, `/mnt/d/`), review 2026-11-24, sixth: only for a letter of a volume
  // nothing protects, since a short folder name in an inline program's text (`'/a/b'`) is not a drive.
  const unprotectedLetters = new Set(pc.unprotectedVolumes.map(driveOf).filter((d): d is string => d !== null))
  for (const t of named.texts) {
    for (const m of t.matchAll(MSYS_SPELLING)) {
      const d = m[1].toUpperCase()
      if (!unprotectedLetters.has(d) || (readDrives.has(d) && !unread)) continue
      add('unprotected-volume', order, () => `this command spells the drive ${d}: (a volume Windows cannot protect) ${textReason}`, undefined, hint, false)
      return
    }
  }
  for (const t of named.texts) {
    const text = t.replace(/\^/g, '')
    for (const re of VOLUME_SPELLINGS) {
      for (const m of text.matchAll(re)) {
        // A one-letter option glued to a colon and a wildcard (`expand a.cab -F:* out`) is an option, not a drive
        // (review 2026-11-24, eighth); a drive is followed by a separator.
        if (re === VOLUME_SPELLINGS[0] && /[*?]$/.test(m[0]) && /[-/]/.test(text[(m.index ?? 0) - 1] ?? '')) continue
        const d = m[1].toUpperCase()
        if (pc.drives.includes(d) || (readDrives.has(d) && !unread)) continue
        add('unprotected-volume', order, () => `this command spells the drive ${d}: (a drive this run has no folder on) ${textReason}`, undefined, hint, false)
        return
      }
    }
  }
}

function insideRoots(real: string, pc: PathContext): boolean {
  return [pc.missionCwd, ...pc.extraRoots, pc.sandbox.home, pc.sandbox.tmp, pc.sandbox.scratch].some(r => insidePath(r, real, pc.platform))
}

/** A link target is resolved like any path, except on a volume the policy judges lexically. */
function isRootish(c: string, pc: PathContext): boolean {
  if (isUnc(c)) return true
  if (pc.platform === 'win32') { const d = driveOf(c); return d === null || !pc.drives.includes(d) || pc.unprotectedVolumes.some(v => insidePath(v, c, 'win32')) }
  return /^[A-Za-z]:/.test(c) || pc.unprotectedVolumes.some(v => insidePath(v, c, 'posix'))
}

function reasonFor(rule: PathRule, detail: string, n: NamedPath, real: string): string {
  const op = OP_TEXT[n.op] ?? n.op
  const s = shown(n.raw, real)
  // A recursive delete through a name nothing set (review 2026-11-23): say what the word really names.
  if (n.unsetName) return `${n.unsetName} is not set in this command, so ${n.raw.trim()} names a folder at the root of the current drive (${real}) and this call would ${op} it; a variable does not carry over from one call to the next`
  switch (rule) {
    case 'home': return `this call would ${op} ${s}, which is the home folder itself`
    case 'home-dot': return `this call would ${op} ${s}, which is in ${detail}, a dot-entry of the home folder`
    case 'state': return `this call would ${op} ${s}, which is in ${detail}`
    case 'ancestor': return `this call would ${op} ${s}, a folder that contains the home folder or a protected folder`
    case 'unprotected-volume': return `this call would ${op} ${s}, which is on ${detail}`
    case 'outside': return `this call would ${op} ${s}, which is outside the mission folder and the scratch folder`
    case 'git-internals': return `this call would write ${s}, which is inside the repository's .git folder`
    case 'no-access': return NO_ACCESS_REASON
    default: return `this call would ${op} ${s}`
  }
}

/** Rule R11: what is allowed but worth a record. */
function escalation(toolName: string, named: NamedCall, pc: PathContext): PathVerdict {
  const P = pathModule(pc.platform)
  const roots = [pc.missionCwd, ...pc.extraRoots]
  const rootHits: string[] = []
  let recursive = false
  for (const n of named.paths) {
    if (n.inherited || (n.op !== 'delete' && n.op !== 'move')) continue
    if (n.verb !== undefined && /^git\b/.test(n.verb)) continue
    // A filtered delete of items under the folder (`find . -name '*.pyc' -delete`, `del /s *.pyc`, an item of a
    // listing) is not the whole folder; `*` alone is (review 2026-11-24, sixth).
    if (n.children && !/(?:^|[\\/])\*["']?$/.test(n.raw.trim())) continue
    const real = n.real()
    const hit = roots.some(r => same(real, r, pc.platform) || same(real, P.join(r, '.git'), pc.platform))
    if (hit) { rootHits.push(real); recursive ||= n.recursive }
  }
  const note = (rule: EscalateNote['rule'], reason: string, targets: string[], rec: boolean): PathVerdict =>
    ({ kind: 'escalate', reason, note: { rule, reason, targets: [...new Set(targets)].slice(0, 8), recursive: rec, isolation: pc.isolation } })
  if (rootHits.length) return note('root-delete', `this call deletes or moves the whole of a folder this run works in (${toolName})`, rootHits, recursive)
  const scan = named.scan
  if (scan?.gitDestructive) {
    const targets = named.paths.filter(n => n.verb !== undefined && /^git\b/.test(n.verb) && (n.op === 'delete' || n.op === 'write')).map(n => n.real())
    return note('git-destructive', `this git command throws away work that is not committed (${toolName})`, targets,
      named.paths.some(n => n.verb !== undefined && /^git\b/.test(n.verb) && n.recursive))
  }
  // A recursive delete or move through a target the scan cannot read was escalated here until the fourth
  // review of 2026-11-23; it is refused now (RS1, `refuseUnreadTarget`). An inline program's write to a path it
  // computes runs and is recorded (sixth review, policy item 3).
  if (inlineUnreadWrite(named, pc)) {
    const um = scan?.unresolvedMutation
    return note('inline-unread-write', `this inline program writes to a path it computes (${um?.verb ?? 'a write'}), which cannot be read before it runs (${toolName})`, [], false)
  }
  return { kind: 'allow' }
}

// ─── The entry points ──────────────────────────────────────────────────────────────────────────

/**
 * The protected-path verdict for one tool call. With no run context: allow, at once. In a contained
 * run: a refusal for a faulty context, otherwise the judgement of every path the call names. Never
 * throws, never spawns, never writes.
 */
export function checkProtectedPaths(toolName: string, input: Record<string, unknown>, toolCwd: string,
  ctx: RunContainment | null = runContainment()): PathVerdict {
  if (ctx === null) return { kind: 'allow' }
  if (containmentOff('paths', ctx)) return { kind: 'allow' }
  let pc: PathContext | null = null
  try {
    const c = pathContextOf(ctx)
    if (!c.ok) return { kind: 'refuse', rule: 'containment', reason: c.fault, text: refusalText('containment', c.fault) }
    pc = c.pc
    const named = namePaths(toolName, input, toolCwd, pc.homes,
      { platform: pc.platform, real: pc.real, drives: pc.drives, lexicalRoots: pc.unprotectedVolumes })
    if (named.paths.length === 0 && named.spellings.length === 0 && named.texts.length === 0 && named.faults.length === 0) return { kind: 'allow' }
    return judgeCall(toolName, named, pc, toolCwd)
  } catch (e) {
    console.log(`[paths] check failed: ${(e as Error)?.message ?? String(e)}`)
    const reason = 'the path check could not read this call (an internal error in the path check), and an unattended run does not run what it cannot read'
    if (pc) return refusal(pc, 'unreadable', reason)
    return { kind: 'refuse', rule: 'unreadable', reason, text: refusalText('protected path', reason) }
  }
}

/**
 * One Bash call is judged twice: by `ToolExecutor` before any approval, and by the Bash tool right before
 * its shell starts, for a caller that skips the executor. A scan can take up to `SCAN_BUDGET_MS` on the
 * event loop, so the tool skips its own reading of the very input object the executor judged and did not
 * refuse a moment ago in the same run context, for the same folder and the same command text (review
 * 2026-11-23, third). Any other caller, or a changed input, is judged again.
 */
const judged = new WeakMap<object, { command: string; cwd: string; ctx: RunContainment; at: number }>()
const JUDGED_FOR_MS = 10_000

export function noteBashJudged(input: Record<string, unknown>, toolCwd: string, ctx: RunContainment | null = runContainment()): void {
  if (ctx === null || typeof input.command !== 'string') return
  judged.set(input, { command: input.command, cwd: toolCwd, ctx, at: Date.now() })
}

export function bashJudgedAlready(input: Record<string, unknown>, toolCwd: string, ctx: RunContainment | null = runContainment()): boolean {
  const j = judged.get(input)
  if (j === undefined) return false
  judged.delete(input)
  return ctx !== null && j.ctx === ctx && j.cwd === toolCwd && j.command === input.command && Date.now() - j.at < JUDGED_FOR_MS
}

/**
 * Why this process cannot run tool calls under the path check, or null. Four decisions against the
 * live context, executing and creating nothing. `decide` is the test seam; production never passes it.
 */
export function pathGuardFault(ctx: RunContainment | null = runContainment(),
  decide: typeof checkProtectedPaths = checkProtectedPaths): string | null {
  if (ctx === null) return NO_CONTAINMENT
  if (containmentOff('paths', ctx)) return null
  const c = pathContextOf(ctx)
  if (!c.ok) return c.fault
  const pc = c.pc
  const P = pathModule(pc.platform)
  const wrong = (n: number) => `the path check does not answer correctly for this run (probe ${n})`
  const isRefuse = (v: PathVerdict, rule: string) => v.kind === 'refuse' && v.rule === rule
  try {
    if (!isRefuse(decide('Bash', { command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.cynco-path-guard-probe"' }, pc.missionCwd, ctx), 'home-dot')) return wrong(1)
    if (!isRefuse(decide('Write', { file_path: P.join(pc.home, '.cynco-path-guard-probe', 'probe.txt'), content: 'x' }, pc.missionCwd, ctx), 'home-dot')) return wrong(2)
    if (decide('Write', { file_path: P.join(pc.missionCwd, 'path-guard-probe.txt'), content: 'x' }, pc.missionCwd, ctx).kind !== 'allow') return wrong(3)
    if (decide('Write', { file_path: P.join(pc.sandbox.scratch, 'path-guard-probe.txt'), content: 'x' }, pc.missionCwd, ctx).kind !== 'allow') return wrong(4)
  } catch (e) {
    console.log(`[paths] probe failed: ${(e as Error)?.message ?? String(e)}`)
    return `the path check does not answer correctly for this run (${(e as Error)?.message ?? String(e)})`
  }
  return null
}

/** The capability probe: a context, the layer on, and the four decisions right. */
export function pathGuardProbe(ctx: RunContainment | null = runContainment()): boolean {
  return ctx !== null && !containmentOff('paths', ctx) && pathGuardFault(ctx) === null
}
