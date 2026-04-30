import type { WorkflowDefinition } from '../types.js'

export const reviewWorkflow: WorkflowDefinition = {
  name: 'review',
  displayName: 'Code Review',
  description: 'Structured code review: gather context, analyze quality, and produce a report.',
  initialPhase: 'gather',
  phases: {
    gather: {
      name: 'gather',
      instruction: 'Gather all relevant context for the review. Read the changed files, understand the surrounding code, check git history for context, and identify the scope of the review. Do not make any judgments yet.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['analyze'],
    },
    analyze: {
      name: 'analyze',
      instruction: 'Analyze the code for correctness, clarity, performance, security, and test coverage. Identify issues by severity (critical, major, minor, nit). Consider edge cases, error handling, and consistency with the rest of the codebase.',
      allowedTools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['report'],
    },
    report: {
      name: 'report',
      instruction: 'Write a clear, actionable review report. Group findings by severity. For each issue, include the file and line reference, a description of the problem, and a concrete suggestion. End with an overall assessment.',
      allowedTools: ['Read', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['done'],
    },
  },
}
