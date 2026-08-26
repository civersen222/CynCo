import { getToolByName } from './registry.js'
import { shouldAutoApprove, getToolRisk, type ToolTrustProfile } from './approvalGate.js'
import type { ToolResult } from './types.js'
import { DoomLoopDetector } from './doomLoop.js'
import { capToolResult } from './resultCap.js'
import { ToolScorer } from './toolScorer.js'
import { callTouchesSealed, redactSealed, SEALED_REFUSAL } from './sealedPaths.js'
import { withCodeIndexNudge } from './toolHints.js'

export type RequestApprovalFn = (
  toolName: string,
  input: Record<string, unknown>,
  risk: 'low' | 'medium' | 'high',
) => Promise<boolean>

export type ToolExecutorOptions = {
  cwd: string
  requestApproval: RequestApprovalFn
  trustProfile?: ToolTrustProfile
  approveAll?: boolean
  contextLength?: number
  toolScorer?: ToolScorer
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
): string | null {
  if (!WORKSPACE_MUTATING_TOOLS.has(toolName)) return null
  const raw = (input.file_path as string) ?? (input.path as string) ?? ''
  if (!raw) return null
  const abs = /^([a-zA-Z]:[\\/]|\/)/.test(raw)
    ? raw
    : `${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`
  return immutablePaths().find(p => samePath(p, abs)) ?? null
}

export class ToolExecutor {
  private cwd: string
  private requestApproval: RequestApprovalFn
  private trustProfile?: ToolTrustProfile
  private approveAll: boolean
  private contextLength: number
  private doomLoop = new DoomLoopDetector(3)
  private toolScorer?: ToolScorer

  constructor(opts: ToolExecutorOptions) {
    this.cwd = opts.cwd
    this.requestApproval = opts.requestApproval
    this.trustProfile = opts.trustProfile
    this.approveAll = opts.approveAll ?? false
    this.contextLength = opts.contextLength ?? 32768
    this.toolScorer = opts.toolScorer
  }

  setApproveAll(value: boolean): void {
    this.approveAll = value
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
  }

  getToolScorer(): ToolScorer | undefined {
    return this.toolScorer
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = getToolByName(toolName)
    if (!tool) {
      return { output: `Error: unknown tool "${toolName}"`, isError: true }
    }

    // F37, and BEFORE the immutable check on purpose: that one's refusal says
    // "you may Read it as often as you like", which is right for a brief and
    // catastrophic for a held-out gate. A path that is both must answer sealed.
    if (callTouchesSealed(toolName, input, this.cwd)) {
      return { output: SEALED_REFUSAL, isError: true }
    }

    const immutable = immutableTargetOf(toolName, input, this.cwd)
    if (immutable) {
      return {
        output: `Error: ${immutable} is part of how this task is measured, and is read-only.\n`
          + `It is either the specification you were given or a gate script that scores your work. `
          + `You may Read it as often as you like. Changing it would replace the thing your work is `
          + `measured against with your own account of it — and then passing proves nothing. If it `
          + `is wrong, unclear, or looks out of date, say so in your reply and work from the code. `
          + `Do not correct it yourself.`,
        isError: true,
      }
    }

    const autoApprove = shouldAutoApprove(toolName, this.trustProfile, this.approveAll)
    if (!autoApprove) {
      const risk = getToolRisk(toolName)
      const approved = await this.requestApproval(toolName, input, risk)
      if (!approved) {
        return { output: `Tool call denied by user: ${toolName}`, isError: true }
      }
    }

    try {
      const result = await tool.execute(input, this.cwd)

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
      // the hint cannot be truncated away, and unconditionally so a CodeIndex
      // call resets the crawl counter even on a doom-loop turn.
      const nudged = withCodeIndexNudge(
        toolName, input, capToolResult(redactSealed(result.output), this.contextLength), result.isError)
      const capped = {
        output: nudged,
        isError: result.isError,
        // Carried, not re-derived. Rebuilding the result here is the one place
        // a classification set by the tool that ran the check can be silently
        // dropped, and downstream has no way to recover it: the whole point of
        // the flag is that the verdict is invisible in the prose.
        arbiterVerdict: result.arbiterVerdict,
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
        }
      }

      this.toolScorer?.record(toolName, !capped.isError)
      return capped
    } catch (err) {
      return {
        output: `Tool execution error (${toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
