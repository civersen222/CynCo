import type { WorkflowDefinition } from '../types.js'

export const planningWorkflow: WorkflowDefinition = {
  name: 'planning',
  displayName: 'Plan and Execute',
  description: 'Create a step-by-step plan, execute each step, and verify before moving on.',
  initialPhase: 'create_plan',
  phases: {
    create_plan: {
      name: 'create_plan',
      instruction: 'Analyze the task and create a detailed, ordered implementation plan. Break the work into discrete, verifiable steps. Read relevant code to understand the current state before planning. Output the plan clearly before proceeding.',
      allowedTools: ['Read', 'Glob', 'Grep'],
      gate: { type: 'model_done' },
      transitions: ['execute_step'],
    },
    execute_step: {
      name: 'execute_step',
      instruction: 'Execute the current step from the plan. Make the necessary changes using any available tools. Be precise and focused — complete only the current step, not future ones.',
      gate: { type: 'model_done' },
      transitions: ['verify_step'],
    },
    verify_step: {
      name: 'verify_step',
      instruction: 'Verify that the step was completed correctly. Run tests, check the output, or inspect changed files as appropriate. If the step is complete and correct, either proceed to the next step or mark as done if all steps are finished.',
      gate: { type: 'model_done' },
      transitions: ['execute_step', 'done'],
    },
  },
}
