import type { WorkflowDefinition } from '../types.js'

export const brainstormWorkflow: WorkflowDefinition = {
  name: 'brainstorm',
  displayName: 'Brainstorming',
  description: 'Guided ideation: understand context, explore approaches, propose solutions, refine, write spec.',
  initialPhase: 'understand',
  phases: {
    understand: {
      name: 'understand',
      instruction: 'Understand the user\'s idea. Ask ONE clarifying question at a time.\nExplore the codebase to understand existing patterns and constraints.\nDo not propose solutions yet — focus on understanding the problem space.',
      allowedTools: ['Read', 'Glob', 'Grep', 'Git', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['explore'],
    },
    explore: {
      name: 'explore',
      instruction: 'Explore 2-3 different approaches to the problem.\nFor each approach, describe: what it does, trade-offs, and effort estimate.\nRecommend one approach and explain why.',
      allowedTools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['propose'],
    },
    propose: {
      name: 'propose',
      instruction: 'Present a concrete design for the recommended approach.\nCover: architecture, components, data flow, key interfaces.\nAsk if the user wants changes before proceeding.',
      allowedTools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['refine', 'spec'],
    },
    refine: {
      name: 'refine',
      instruction: 'Incorporate the user\'s feedback into the design.\nAddress specific concerns or change requests.\nPresent the updated design.',
      allowedTools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
      gate: { type: 'model_done' },
      transitions: ['propose', 'spec'],
    },
    spec: {
      name: 'spec',
      instruction: 'Write the final design spec document.\nInclude: goal, architecture, file structure, interfaces, testing strategy.\nSave it to a file the user specifies (or suggest a location).',
      gate: { type: 'model_done' },
      transitions: ['done'],
    },
  },
}
