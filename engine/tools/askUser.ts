/**
 * AskUser — a human-in-the-loop tool. Lets the model pose a clarifying question
 * (optionally with a set of suggested options) to the human and block on the
 * answer. Routed over the existing approval/WS bridge via the global AskBroker.
 */
import type { ToolImpl } from './types.js'
import { globalAskBroker } from './askBroker.js'

export const askUserTool: ToolImpl = {
  name: 'AskUser',
  description:
    'Ask the human a clarifying question and wait for their answer. Use when you are blocked on a ' +
    'decision only the user can make (ambiguous requirements, a risky/irreversible action, or a ' +
    'choice between approaches). Optionally provide a short list of suggested options. Returns the ' +
    "user's typed answer. Do not use for routine progress — only when you genuinely need input.",
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question to put to the human. Be specific and concise.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of suggested answers the human can pick from.',
      },
    },
    required: ['question'],
  },
  tier: 'auto',
  execute: async (input) => {
    const question = (input.question as string) || ''
    if (!question.trim()) {
      return { output: 'question is required', isError: true }
    }
    const options = Array.isArray(input.options) ? (input.options as string[]) : undefined

    const answer = await globalAskBroker.ask(question, options)
    if (!answer) {
      return { output: 'No answer from the user (timed out). Proceed using your best judgment.', isError: false }
    }
    return { output: answer, isError: false }
  },
}
