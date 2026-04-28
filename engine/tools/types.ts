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
  execute: (input: Record<string, unknown>, cwd: string) => Promise<ToolResult>
}
