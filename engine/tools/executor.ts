import { getToolByName } from './registry.js'
import { shouldAutoApprove, getToolRisk, isDownloadCommand, DOWNLOAD_REFUSAL, type ToolTrustProfile } from './approvalGate.js'
import type { ToolImpl, ToolResult } from './types.js'
import { DoomLoopDetector } from './doomLoop.js'
import { capToolResult } from './resultCap.js'
import { ToolScorer } from './toolScorer.js'
import { callTouchesSealed, redactSealed, SEALED_REFUSAL } from './sealedPaths.js'
import { secretPathOf, SECRET_REFUSAL, secretApprovalRefusal } from './secretPaths.js'
import { checkProtectedPaths, noteBashJudged, type EscalateNote } from './protectedPaths.js'
import { namePaths, type NamedCall } from './toolPaths.js'
import { realPathOf } from '../realPath.js'
import { withCodeIndexNudge } from './toolHints.js'
import { isWrongPathAnswer } from './impl/pathHint.js'
import { toolAudit, containmentFault, type AuditSrc } from '../audit/toolAudit.js'
import { refusalReasonOf, refusalText, refusalLayerOf } from '../containment.js'

export type RequestApprovalFn = (
  toolName: string,
  input: Record<string, unknown>,
  risk: 'low' | 'medium' | 'high',
) => Promise<boolean>

export type Grader = (toolName: string, input: Record<string, unknown>) => { level: 'safe' | 'risky' | 'dangerous'; reason: string }

export type ToolExecutorOptions = {
  cwd: string
  requestApproval: RequestApprovalFn
  trustProfile?: ToolTrustProfile
  approveAll?: boolean
  contextLength?: number
  toolScorer?: ToolScorer
  grader?: Grader
  /** Which records this executor writes: 'tool' (default) for the loop's, 'subagent' for a sub-agent's. */
  auditSrc?: AuditSrc
}

/**
 * Tools whose success means the source is not what it was.
 *
 * Editors only. `Bash` is deliberately absent even though the shell can write
 * files (finding (f)) — a successful `ls` would then clear every failure count
 * and the detector would fire on nothing but strict back-to-back repetition.
 * The blind spot is real and named rather than papered over with a rule that
 * cannot tell `python -c "open(...,'w')"` from `git status`. Closing it wants
 * the per-path git signature the Bash path already computes, which does not
 * reach this layer yet.
 */
const WORKSPACE_MUTATING_TOOLS = new Set([
  'Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit',
])

/**
 * Paths the task may read but must not write: its own specification.
 *
 * Measured on Gilded L4.6b. Ten minutes in, the run replaced the brief it had
 * been given — a file it had already Read three times — with a plausible
 * reconstruction of its own, inventing a symbol (`INITIATIVE_VERBS`) that
 * exists nowhere in the repository, and then spent thirty turns searching for
 * it. Nothing objected: `Write` is risk-rated medium and was auto-approved,
 * the shrink guard keys on >=50% shrinkage so it catches gutting and misses
 * replacement, and the brief sits outside the contract mechanism entirely, so
 * none of the protections built for contract replacement applied to it.
 *
 * The rule is that the specification is evidence, not workspace: a document
 * the agent may rewrite is a document it cannot also be measured against.
 *
 * Two sources, unioned:
 *
 *  - LOCALCODE_IMMUTABLE_PATHS (os-path-separated, like PATH), for a path fixed
 *    for the whole life of the process.
 *  - `setTaskImmutablePaths`, for paths that belong to ONE task — the gate
 *    scripts its harness contract names.
 *
 * The second exists because the first turned out to protect nothing. Finding
 * (ag): the env var was the only source, and no production code ever set it —
 * measured by grep, the only writers in the tree are this guard's own unit
 * tests. It could not have worked. The component that knows which files are
 * instruments is the mission driver, which is a WebSocket client in a different
 * process from the one that reads the variable. A guard whose input can only be
 * supplied by something that cannot supply it is decoration.
 *
 * Read at call time rather than construction so a test, and a task boundary,
 * can change it.
 */
let taskImmutablePaths: string[] = []

/**
 * Declare the instrument files for the current task. Replaces any previous set,
 * so a task that supplies none clears the last task's — these are scoped to one
 * task and must not leak into the next.
 */
export function setTaskImmutablePaths(paths: string[]): void {
  taskImmutablePaths = [...paths]
}

function immutablePaths(): string[] {
  const raw = process.env.LOCALCODE_IMMUTABLE_PATHS
  const fromEnv = raw
    ? raw.split(process.platform === 'win32' ? ';' : ':').map(s => s.trim()).filter(Boolean)
    : []
  return [...fromEnv, ...taskImmutablePaths]
}

/** Same spelling for two paths written by different authors. Win32 folds case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/** The declared-immutable path this input would write, if any. */
export function immutableTargetOf(
  toolName: string, input: Record<string, unknown>, cwd: string,
  namer: (toolName: string, input: Record<string, unknown>, cwd: string) => NamedCall = namePaths,
): string | null {
  const mutating = WORKSPACE_MUTATING_TOOLS.has(toolName)
  if (!mutating && toolName !== 'Bash') return null
  const declared = immutablePaths()
  if (declared.length === 0) return null
  if (mutating) {
    const raw = (input.file_path as string) ?? (input.path as string) ?? ''
    if (raw) {
      const abs = /^([a-zA-Z]:[\\/]|\/)/.test(raw)
        ? raw
        : `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`
      const hit = declared.find(p => samePath(p, abs))
      if (hit) return hit
    }
  }
  // Every path the call names (F242): nested edits, notebook and patch targets, and for Bash the exact
  // target of a write, a delete or a move.
  for (const n of namer(toolName, input, cwd).paths) {
    if (n.op !== 'write' && n.op !== 'delete' && n.op !== 'move') continue
    if (n.inherited || n.children) continue
    const hit = declared.find(p => samePath(p, n.path) || samePath(realPathOf(p, { quiet: true }), n.real()))
    if (hit) return hit
  }
  return null
}

/**
 * The fault a result carries: a containment or integrity refusal, with its first line. Null for
 * anything else. A result that has an `exitCode` key came from a process that RAN, so it is never a
 * refusal, whatever its text says: a command cannot end its own run as a harness fault by printing
 * the prefix (a refusal made before a process started carries no `exitCode`, see types.ts).
 */
export function refusalFaultOf(result: ToolResult): { layer: 'containment' | 'integrity'; reason: string } | null {
  if (!result.isError || 'exitCode' in result) return null
  const layer = refusalLayerOf(result.output)
  if (layer !== 'containment' && layer !== 'integrity') return null
  return { layer, reason: refusalReasonOf(result.output) }
}

export class ToolExecutor {
  private cwd: string
  private requestApproval: RequestApprovalFn
  private trustProfile?: ToolTrustProfile
  private approveAll: boolean
  private contextLength: number
  private doomLoop = new DoomLoopDetector(3)
  private toolScorer?: ToolScorer
  private grader: Grader | null
  private auditSrc: AuditSrc
  /** The CodeIndex adoption nudge on retrieval results; off in a project chat, which has no CodeIndex. */
  private codeIndexHints = true
  /** `<tool>:ok` / `<tool>:failed` outcomes this model call already scored; null until a caller marks a call (`beginModelCall`). */
  private scoredThisCall: Set<string> | null = null

  constructor(opts: ToolExecutorOptions) {
    this.cwd = opts.cwd
    this.requestApproval = opts.requestApproval
    this.trustProfile = opts.trustProfile
    this.approveAll = opts.approveAll ?? false
    this.contextLength = opts.contextLength ?? 32768
    this.toolScorer = opts.toolScorer
    this.grader = opts.grader ?? null
    this.auditSrc = opts.auditSrc ?? 'tool'
  }

  setApproveAll(value: boolean): void {
    this.approveAll = value
  }

  /**
   * Whether a call to this tool would run here without a question to the user. It is what a
   * sub-agent, which approves its own calls, may be handed (`agents/trustTier.ts`). A project
   * chat grades each call by its input, so nothing can be promised ahead of the call: false.
   */
  runsUnasked(toolName: string): boolean {
    if (this.grader) return false
    return shouldAutoApprove(toolName, this.trustProfile, this.approveAll)
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  setGrader(g: Grader | null): void {
    this.grader = g
  }

  setCodeIndexHints(on: boolean): void {
    this.codeIndexHints = on
  }

  getToolScorer(): ToolScorer | undefined {
    return this.toolScorer
  }

  /**
   * Mark the start of a model call's tool batches. From then on the trust
   * score takes at most one success and one failure per tool per call: calls
   * the model fired together are one decision, so three failed Edits in one
   * call are one failure, not three that demote Edit, and a call that both
   * succeeded and failed with a tool counts one of each (F178). The unit is the
   * model call on both sides; capping failures alone let three good Reads in
   * one call outweigh three later calls that each failed. A caller that never
   * marks a call (a sub-agent's executor, a test) scores every call.
   */
  beginModelCall(): void {
    this.scoredThisCall = new Set()
  }

  async execute(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const pre = await this.preRun(toolName, input)
    const audit = toolAudit()
    if ('refusal' in pre) {
      // Every pre-run refusal is recorded here, once, so no early return can be forgotten (F242).
      audit?.refused({
        src: this.auditSrc, by: 'executor', tool: toolName, input, cwd: this.cwd,
        layer: refusalLayerOf(pre.refusal.output) ?? undefined, reason: pre.refusal.output,
      })
      this.raiseFault(pre.refusal)
      return pre.refusal
    }
    const tool = pre.tool
    // F242: the full input is on disk, fsynced, BEFORE the tool starts. Outside the
    // `try` on purpose: this return must not pass the doom-loop check, the scorer or
    // the rebuild below, and a refusal here is a result, never a throw.
    const started = audit
      ? audit.start({ src: this.auditSrc, tool: toolName, input, cwd: this.cwd, ...(pre.escalate ? { escalate: pre.escalate } : {}) })
      : null
    if (started && !started.ok) return { output: refusalText('audit', started.reason), isError: true }
    const startedAt = Date.now()
    let ended = false
    const end = (r: { isError: boolean; exitCode?: number | null; output: string }) => {
      if (!audit || !started || ended) return
      ended = true
      audit.end(started.call, { ...r, ms: Date.now() - startedAt })
    }

    try {
      const result = await tool.execute(input, this.cwd, signal)
      end({ isError: result.isError, ...('exitCode' in result ? { exitCode: result.exitCode } : {}),
            output: redactSealed(result.output) })
      this.raiseFault(result)

      // A successful edit means every recorded failure describes a repository
      // that no longer exists. Cleared BEFORE this call is judged, so an edit
      // and the test run that follows it are never counted against each other.
      if (!result.isError && WORKSPACE_MUTATING_TOOLS.has(toolName)) {
        this.doomLoop.noteWorkspaceChanged()
      }

      // Doom loop detection: catch repeated failing tool calls. The whole input,
      // not a prefix — see finding (t) and doomLoop.ts.
      // An arbiter's "not yet" is not a failing call. The run is SUPPOSED to
      // keep asking the same question with the same arguments until the answer
      // changes; that is the shape of the doom loop only if you cannot tell a
      // verdict from a fault, which is what `arbiterVerdict` exists to say.
      const isDoomLoop = this.doomLoop.check(
        toolName, JSON.stringify(input), result.isError && !result.arbiterVerdict)
      // F37 layer 2. Applied to every tool's output, not just the listing ones,
      // because a sealed name can surface anywhere a path does — a grep hit, a
      // stack trace, a `git status`. Before the cap, so a truncated result is
      // truncated after the redaction and never after only part of it.
      // CodeIndex adoption nudge (see toolHints.ts): prepended AFTER the cap so
      // the hint cannot be truncated away, and on every call (doom-loop turns
      // included) so a CodeIndex call resets the crawl counter.
      // Not in a project chat: it has no CodeIndex to point at.
      const cappedOutput = capToolResult(redactSealed(result.output), this.contextLength)
      const nudged = this.codeIndexHints ? withCodeIndexNudge(toolName, input, cappedOutput, result.isError) : cappedOutput
      const capped = {
        output: nudged,
        isError: result.isError,
        // Carried, not re-derived. Rebuilding the result here is the one place
        // a classification set by the tool that ran the check can be silently
        // dropped, and downstream has no way to recover it: the whole point of
        // the flag is that the verdict is invisible in the prose.
        arbiterVerdict: result.arbiterVerdict,
        // Carried for the same reason as arbiterVerdict: a rebuild is where a field is silently lost.
        ...('exitCode' in result ? { exitCode: result.exitCode } : {}),
      }
      if (isDoomLoop) {
        // Appended, never substituted. The old code replaced the tool's output
        // with the scolding, so a model stuck on a failing test was denied the
        // test report — the one thing that could have got it unstuck. An error
        // message is a control signal: it must add what the engine knows, not
        // remove what the tool said.
        return {
          output: `${capped.output}\n\n[engine] DOOM LOOP DETECTED: ${this.doomLoop.getSuggestion()}`,
          isError: true,
          arbiterVerdict: capped.arbiterVerdict,
          ...('exitCode' in capped ? { exitCode: capped.exitCode } : {}),
        }
      }

      // A wrong path is the model's guess, not the tool failing: not scored
      // either way, and flagged so the loop's counters leave it out too (F178).
      // Checked on the tool's own answer — the cap and the CodeIndex nudge
      // above may have put text in front of it.
      if (isWrongPathAnswer(toolName, result.output, result.isError)) return { ...capped, wrongPath: true }
      // One success and one failure per tool per model call, once the caller marks calls (F178).
      if (this.scoredThisCall) {
        const outcome = `${toolName}:${capped.isError ? 'failed' : 'ok'}`
        if (this.scoredThisCall.has(outcome)) return capped
        this.scoredThisCall.add(outcome)
      }
      this.toolScorer?.record(toolName, !capped.isError)
      return capped
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      end({ isError: true, exitCode: null, output: `threw: ${message}` })
      return {
        output: `Tool execution error (${toolName}): ${message}`,
        isError: true,
      }
    }
  }

  /**
   * Every check that runs before a tool, in their order: unknown tool; sealed; immutable;
   * secret-refuse; protected paths; grader, or download / secret-approval / approval. A refusal
   * comes back as a result for `execute` to record; otherwise the tool and the path check's
   * escalate note, if it had one.
   */
  private async preRun(toolName: string, input: Record<string, unknown>)
    : Promise<{ refusal: ToolResult } | { tool: ToolImpl; escalate?: EscalateNote }> {
    const tool = getToolByName(toolName)
    if (!tool) {
      return { refusal: { output: `Error: unknown tool "${toolName}"`, isError: true } }
    }

    // F37, and BEFORE the immutable check on purpose: that one's refusal says
    // "you may Read it as often as you like", which is right for a brief and
    // catastrophic for a held-out gate. A path that is both must answer sealed.
    if (callTouchesSealed(toolName, input, this.cwd)) {
      return { refusal: { output: SEALED_REFUSAL, isError: true } }
    }

    const immutable = immutableTargetOf(toolName, input, this.cwd)
    if (immutable) {
      return { refusal: {
        output: `Error: ${immutable} is part of how this task is measured, and is read-only.\n`
          + `It is either the specification you were given or a gate script that scores your work. `
          + `You may Read it as often as you like. Changing it would replace the thing your work is `
          + `measured against with your own account of it — and then passing proves nothing. If it `
          + `is wrong, unclear, or looks out of date, say so in your reply and work from the code. `
          + `Do not correct it yourself.`,
        isError: true,
      } }
    }

    // Secret paths (GLM review S1, 2026-11-06, secretPaths.ts): the engine's
    // own token file is refused outright; SSH keys, .env files and system
    // credential files need the user's yes whatever the tier or grade says, and
    // where there is no user (approve-all) they are refused like a download.
    const secret = secretPathOf(toolName, input, this.cwd)
    if (secret?.action === 'refuse') {
      return { refusal: { output: SECRET_REFUSAL, isError: true } }
    }

    // F242, layer 2 (protected paths). In a contained run a call that would write, delete, move, link
    // or hand an unknown program a path outside the mission folder and the run's sandbox is refused
    // here, before any grade or approval: approve-all does not open it. With no run context this
    // answers allow at once.
    const guard = checkProtectedPaths(toolName, input, this.cwd)
    if (guard.kind === 'refuse') {
      console.log(`[paths] refused ${guard.rule} ${toolName}: ${guard.target ?? '-'}`)
      return { refusal: { output: redactSealed(guard.text), isError: true } }
    }
    // The Bash tool need not read this same input again before its shell starts (protectedPaths.ts).
    if (toolName === 'Bash') noteBashJudged(input, this.cwd)
    // `escalate` is where a yes/no will one day be asked. Today it is a record and nothing else.
    const escalate = guard.kind === 'escalate' ? guard.note : null
    if (escalate) console.log(`[paths] escalate ${escalate.rule} ${toolName}: ${escalate.targets.join(', ')} (allowed: no decision model is installed)`)

    if (this.grader) {
      // Project mode: one grade decides. A download is the grader's `risky`
      // (the user approves every download), so the approve-all refusal below
      // does not apply — there IS a user to ask in a project chat.
      const g = this.grader(toolName, input)
      if (g.level === 'dangerous') return { refusal: { output: `Refused: ${g.reason}`, isError: true } }
      if (g.level === 'risky' || secret) {
        const approved = await this.requestApproval(toolName, input, getToolRisk(toolName))
        if (!approved) return { refusal: { output: `Tool call denied by user: ${toolName}`, isError: true } }
      }
    } else {
      // Downloads never ride on approve-all (see approvalGate.ts). Under
      // approve-all there is no user to ask, so the answer is a refusal that
      // names the sanctioned route; interactively, it is a forced approval card.
      const download = toolName === 'Bash' && isDownloadCommand(String(input.command ?? ''))
      if (download && this.approveAll) {
        return { refusal: { output: DOWNLOAD_REFUSAL, isError: true } }
      }
      if (secret && this.approveAll) {
        return { refusal: { output: secretApprovalRefusal(secret), isError: true } }
      }
      const autoApprove = !download && !secret && shouldAutoApprove(toolName, this.trustProfile, this.approveAll)
      if (!autoApprove) {
        const risk = getToolRisk(toolName)
        const approved = await this.requestApproval(toolName, input, risk)
        if (!approved) {
          return { refusal: { output: `Tool call denied by user: ${toolName}`, isError: true } }
        }
      }
    }

    return { tool, ...(escalate ? { escalate } : {}) }
  }

  /** A containment or integrity refusal ends the run whatever the model does next (entry 3.M5). */
  private raiseFault(result: ToolResult): void {
    const fault = refusalFaultOf(result)
    if (fault) containmentFault(fault.layer, fault.reason)
  }
}
