import type { ToolImpl } from '../types.js'

export const collectAgentTool: ToolImpl = {
  name: 'CollectAgent',
  description:
    'Collect results from a non-blocking sub-agent. Returns the result if the agent is done, or current status if still running.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'The ID of the sub-agent to collect results from',
      },
    },
    required: ['agentId'],
  },
  tier: 'auto',
  execute: async (input, _cwd) => {
    const agentId = input['agentId'] as string

    if (!agentId || agentId.trim() === '') {
      return { output: 'Error: agentId must not be empty', isError: true }
    }

    return {
      output: JSON.stringify({ _collectAgent: true, agentId }),
      isError: false,
    }
  },
}
