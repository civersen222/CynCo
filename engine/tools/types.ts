/**
 * Tool system types for LocalCode.
 */

export type ApprovalTier = 'auto' | 'approval'

export type ToolResult = {
  output: string
  isError: boolean
}

export type ToolImpl = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  tier: ApprovalTier
  /**
   * Default-loaded (`true`) vs load-on-demand (`false`). Core tools are surfaced
   * to the model up front every turn; extended tools stay behind the `load_tools`
   * meta-tool until the model (or a skill / S5) surfaces them. `LOCALCODE_ALL_TOOLS`
   * overrides this and loads everything up front.
   */
  core: boolean
  execute: (input: Record<string, unknown>, cwd: string) => Promise<ToolResult>
}
