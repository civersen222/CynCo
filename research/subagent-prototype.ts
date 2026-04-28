import type { ToolImpl } from '../types.js'

export const subAgentTool: ToolImpl = {
  name: 'SubAgent',
  description: 'Spawn an independent sub-agent to handle a task in isolation. The sub-agent gets its own conversation context and is queued via SubAgentRunner for sequential execution.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Description of the task for the sub-agent' },
      tools: { type: 'array', description: 'Tool names available to the sub-agent (default: all)', items: { type: 'string' } },
    },
    required: ['task'],
  },
  tier: 'approval',
  execute: async (input) => {
    const { SubAgentRunner } = await import('../../agents/runner.js')
    const runner = new SubAgentRunner(async (task) => `[SubAgent] Executed: "${task.task}"`)
    const tools: string[] = Array.isArray(input.tools) ? input.tools : []
    const id = runner.submit(input.task as string, tools)
    return { output: `[SubAgent] Task queued with id=${id}: "${input.task}". Use processNext() or processAll() to execute.`, isError: false }
  },
}
