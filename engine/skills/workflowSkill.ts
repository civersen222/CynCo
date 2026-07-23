// engine/skills/workflowSkill.ts
// Adapter that lets the 7 built-in workflows appear in the skill index and be
// invoked via run_skill — WITHOUT flattening them into prose. A workflow is a
// phase state machine with gates that a flat SKILL.md body cannot express, so
// the SKILL.md for each workflow is only a catalogue entry: when its skill runs,
// the conversation loop drives the existing WorkflowEngine (phases + gates)
// rather than treating the body as the instructions.
//
// Each built-in SKILL.md's frontmatter `tools:` must equal workflowSkillTools()
// for its workflow — the union of every phase's allowedTools — so the tools the
// skill declares match what the workflow will actually allow. A phase with no
// allowedTools imposes no restriction and contributes nothing to the union.

import type { WorkflowDefinition } from '../workflows/types.js'
import {
  tddWorkflow,
  debugWorkflow,
  reviewWorkflow,
  planningWorkflow,
  brainstormWorkflow,
  critiqueWorkflow,
  researchWorkflow,
} from '../workflows/index.js'

/**
 * Skill name → workflow definition. Keyed by the SKILL.md frontmatter `name`
 * (lower-kebab-case), which is the string run_skill receives. Note the planning
 * workflow's internal `.name` is 'planning' but its skill/slash is 'plan'.
 */
export const WORKFLOW_SKILLS: Record<string, WorkflowDefinition> = {
  tdd: tddWorkflow,
  debug: debugWorkflow,
  review: reviewWorkflow,
  plan: planningWorkflow,
  brainstorm: brainstormWorkflow,
  critique: critiqueWorkflow,
  research: researchWorkflow,
}

/** The workflow definition backing a skill name, or undefined if not a workflow skill. */
export function getWorkflowForSkill(name: string): WorkflowDefinition | undefined {
  return WORKFLOW_SKILLS[name]
}

/** True when the skill name is backed by a workflow (drives the WorkflowEngine). */
export function isWorkflowSkill(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_SKILLS, name)
}

/**
 * The union of every phase's allowedTools for a workflow — the canonical value
 * for that workflow skill's frontmatter `tools:`. Phases without allowedTools
 * (unrestricted) contribute nothing. Order follows first appearance across the
 * phase map so the result is deterministic.
 */
export function workflowSkillTools(wf: WorkflowDefinition): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const phase of Object.values(wf.phases)) {
    for (const t of phase.allowedTools ?? []) {
      if (!seen.has(t)) {
        seen.add(t)
        ordered.push(t)
      }
    }
  }
  return ordered
}
