import type { WorkflowDefinition } from '../types.js'

export const planningWorkflow: WorkflowDefinition = {
  name: 'planning',
  displayName: 'Plan and Execute',
  description: 'Create a step-by-step plan, execute each step, and verify before moving on.',
  initialPhase: 'create_plan',
  phases: {
    create_plan: {
      name: 'create_plan',
      instruction: 'Analyze the task and create a detailed implementation plan. Read the relevant files to understand the current state, then OUTPUT YOUR PLAN AS TEXT — a numbered list of steps. Do NOT attempt to Edit or Write files yet. Once you output the plan, the system will advance you to the execution phase where editing tools become available. Keep reading to a maximum of 5-8 files, then write the plan.',
      allowedTools: ['Read', 'Glob', 'Grep', 'CodeIndex'],
      gate: { type: 'model_done' },
      transitions: ['execute_step'],
      maxTurns: 15,
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
