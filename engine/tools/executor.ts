import { getToolByName } from './registry.js'
import { shouldAutoApprove, getToolRisk, type ToolTrustProfile } from './approvalGate.js'
import type { ToolResult } from './types.js'
import { DoomLoopDetector } from './doomLoop.js'

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
}

export class ToolExecutor {
  private cwd: string
  private requestApproval: RequestApprovalFn
  private trustProfile?: ToolTrustProfile
  private approveAll: boolean
  private doomLoop = new DoomLoopDetector(3)

  constructor(opts: ToolExecutorOptions) {
    this.cwd = opts.cwd
    this.requestApproval = opts.requestApproval
    this.trustProfile = opts.trustProfile
    this.approveAll = opts.approveAll ?? false
  }

  setApproveAll(value: boolean): void {
    this.approveAll = value
  }

  setCwd(cwd: string): void {
    this.cwd = cwd
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

      // Doom loop detection: catch repeated failing tool calls
      const inputSummary = JSON.stringify(input).slice(0, 100)
      const isDoomLoop = this.doomLoop.check(toolName, inputSummary, result.isError)
      if (isDoomLoop) {
        const suggestion = this.doomLoop.getSuggestion()
        return {
          output: `DOOM LOOP DETECTED: ${suggestion}\n\nThe same tool call has failed 3+ times with identical input. Try a different approach.`,
          isError: true,
        }
      }

      return result
    } catch (err) {
      return {
        output: `Tool execution error (${toolName}): ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
