export { WorkflowEngine } from './engine.js'
export type { WorkflowEvent } from './engine.js'
export type { WorkflowDefinition, WorkflowState, Phase, GateType } from './types.js'

export { tddWorkflow } from './definitions/tdd.js'
export { debugWorkflow } from './definitions/debug.js'
export { reviewWorkflow } from './definitions/review.js'
export { planningWorkflow } from './definitions/planning.js'
export { brainstormWorkflow } from './definitions/brainstorm.js'
export { critiqueWorkflow } from './definitions/critique.js'

import { tddWorkflow } from './definitions/tdd.js'
import { debugWorkflow } from './definitions/debug.js'
import { reviewWorkflow } from './definitions/review.js'
import { planningWorkflow } from './definitions/planning.js'
import { brainstormWorkflow } from './definitions/brainstorm.js'
import { critiqueWorkflow } from './definitions/critique.js'
import type { WorkflowDefinition } from './types.js'

/** All available workflows, keyed by slash command name. */
export const WORKFLOWS: Record<string, WorkflowDefinition> = {
  '/tdd': tddWorkflow,
  '/debug': debugWorkflow,
  '/review': reviewWorkflow,
  '/plan': planningWorkflow,
  '/brainstorm': brainstormWorkflow,
  '/critique': critiqueWorkflow,
}

/** Get workflow by slash command. */
export function getWorkflow(command: string): WorkflowDefinition | undefined {
  return WORKFLOWS[command]
}
