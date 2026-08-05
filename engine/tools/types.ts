/**
 * Tool system types for LocalCode.
 */

export type ApprovalTier = 'auto' | 'approval'

export type ToolResult = {
  output: string
  isError: boolean
  /**
   * True when `isError` means "the declared arbiter of this task ran and
   * answered no", not "this tool broke".
   *
   * The two are indistinguishable at the call site — both are isError — and
   * treating them alike is what makes the per-tool circuit breaker fire on the
   * one tool the agent is required to keep using. Measured on Gilded I4d2b3d:
   * five consecutive honest "not yet" verdicts from a held-out gate tripped
   * `ContractAssertPass has failed 5 consecutive times`, and the run was told
   * to stop asserting the contract it is judged by.
   *
   * `isDeclaredVerificationCheck` already draws this line for Bash, by reading
   * the command out of the assertion text. A held-out gate has no command in
   * its text and the tool that reports its verdict is not Bash — so the flag is
   * set where the verdict is KNOWN rather than inferred downstream from prose.
   */
  arbiterVerdict?: boolean
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
