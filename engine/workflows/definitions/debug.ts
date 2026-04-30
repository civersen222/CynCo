import type { WorkflowDefinition } from '../types.js'

export const debugWorkflow: WorkflowDefinition = {
  name: 'debug',
  displayName: 'Systematic Debugging',
  description: 'Methodical bug investigation: reproduce, hypothesize, isolate, fix, and verify.',
  initialPhase: 'reproduce',
  phases: {
    reproduce: {
      name: 'reproduce',
      instruction: 'Reproduce the bug reliably. Understand the exact conditions under which it occurs. Document the steps to reproduce and the actual vs expected behavior. Use all available tools to explore the codebase and run commands.',
      gate: { type: 'model_done' },
      transitions: ['hypothesize'],
    },
    hypothesize: {
      name: 'hypothesize',
      instruction: 'Form 2-3 specific hypotheses about the root cause. Read the relevant code carefully and reason about what could cause the observed behavior. Document each hypothesis with supporting evidence from the code.',
      allowedTools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['isolate'],
    },
    isolate: {
      name: 'isolate',
      instruction: 'Test each hypothesis systematically. Add logging, run targeted tests, or inspect state to confirm or rule out each hypothesis. Narrow down to the specific line or component causing the bug.',
      gate: { type: 'model_done' },
      transitions: ['fix'],
    },
    fix: {
      name: 'fix',
      instruction: 'Apply the minimal fix that addresses the root cause. Avoid broad changes — fix only what is broken. If the fix reveals a deeper issue, go back to isolate for further investigation.',
      gate: { type: 'model_done' },
      transitions: ['verify', 'isolate'],
    },
    verify: {
      name: 'verify',
      instruction: 'Run the full test suite to confirm the bug is fixed and no regressions were introduced. Reproduce the original steps to confirm the fix. If tests fail or the bug persists, go back to fix.',
      gate: { type: 'model_done' },
      transitions: ['done', 'fix'],
    },
  },
}
