import type { WorkflowDefinition } from '../types.js'

export const critiqueWorkflow: WorkflowDefinition = {
  name: 'critique',
  displayName: 'ICR Critique',
  description: 'Iterative Contextual Refinement: generate a solution, critique it, refine it. Repeat until satisfied.',
  initialPhase: 'generate',
  phases: {
    generate: {
      name: 'generate',
      instruction: 'Generate a complete solution for the task.\nWrite the code, configuration, or content needed.\nDo your best work — the critique phase will find weaknesses.',
      gate: { type: 'model_done' },
      transitions: ['critique'],
    },
    critique: {
      name: 'critique',
      instruction: 'Now switch to CRITIC mode. Review what you just generated with fresh eyes.\nLook for: bugs, edge cases, missing error handling, unclear naming, unnecessary complexity.\nScore the solution 1-10 and list specific issues.\nBe harsh — the goal is to find real problems, not validate.',
      allowedTools: ['Read', 'Grep', 'Glob', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['refine'],
    },
    refine: {
      name: 'refine',
      instruction: 'Address EVERY issue the critic identified.\nMake the specific fixes. Do not skip any finding.\nIf the critique score was 8+ and issues are minor, you can finish.\nOtherwise, loop back for another critique round.',
      gate: { type: 'model_done' },
      transitions: ['generate', 'done'],
    },
  },
}
