import type { ToolImpl } from '../types.js'
import { makeSubAgentConfig, type AgentPersona } from '../../agents/types.js'

const VALID_PERSONAS: AgentPersona[] = ['scout', 'oracle', 'kraken', 'spark', 'architect']

export const spawnAgentTool: ToolImpl = {
  name: 'SubAgent',
  description:
    'Spawn an autonomous sub-agent to work on a task. Agent runs independently with its own context and tools. Use for: parallel research, specialist tasks, task decomposition. Personas: scout (explore codebase), oracle (deep analysis), kraken (testing), spark (refactoring), architect (design).',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task for the sub-agent to perform',
      },
      persona: {
        type: 'string',
        enum: VALID_PERSONAS,
        description: 'The agent persona: scout, oracle, kraken, spark, or architect',
      },
      blocking: {
        type: 'boolean',
        description: 'Whether to wait for the agent to finish before continuing (default: true)',
      },
    },
    required: ['task', 'persona'],
  },
  tier: 'auto',
  execute: async (input, _cwd) => {
    const task = input['task'] as string
    const persona = input['persona'] as string
    const blocking = input['blocking'] !== undefined ? (input['blocking'] as boolean) : true

    if (!task || task.trim() === '') {
      return { output: 'Error: task must not be empty', isError: true }
    }

    if (!VALID_PERSONAS.includes(persona as AgentPersona)) {
      return {
        output: `Invalid persona: "${persona}". Must be one of: ${VALID_PERSONAS.join(', ')}`,
        isError: true,
      }
    }

    const config = makeSubAgentConfig({ task, persona: persona as AgentPersona })

    return {
      output: JSON.stringify({ _subagent: true, config, blocking }),
      isError: false,
    }
  },
}
