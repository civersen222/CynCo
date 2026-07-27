import { getToolByName } from './registry.js'
import { shouldAutoApprove, getToolRisk, type ToolTrustProfile } from './approvalGate.js'
import type { ToolResult } from './types.js'
import { DoomLoopDetector } from './doomLoop.js'
import { capToolResult } from './resultCap.js'
import { ToolScorer } from './toolScorer.js'

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
      const isDoomLoop = this.doomLoop.check(toolName, JSON.stringify(input), result.isError)
      const capped = { output: capToolResult(result.output, this.contextLength), isError: result.isError }
      if (isDoomLoop) {
        // Appended, never substituted. The old code replaced the tool's output
        // with the scolding, so a model stuck on a failing test was denied the
        // test report — the one thing that could have got it unstuck. An error
        // message is a control signal: it must add what the engine knows, not
        // remove what the tool said.
        return {
          output: `${capped.output}\n\n[engine] DOOM LOOP DETECTED: ${this.doomLoop.getSuggestion()}`,
          isError: true,
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
