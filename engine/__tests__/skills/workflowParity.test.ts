import { describe, expect, it } from 'bun:test'
import { loadSkills } from '../../skills/loader.js'
import { ALL_TOOLS } from '../../tools/registry.js'
import { getWorkflow } from '../../workflows/index.js'
import { WorkflowEngine } from '../../workflows/engine.js'
import {
  getWorkflowForSkill,
  isWorkflowSkill,
  workflowSkillTools,
  WORKFLOW_SKILLS,
} from '../../skills/workflowSkill.js'

// Golden parity: the workflow a skill drives must have the SAME phase sequence,
// gates, and tool union as the canonical WorkflowDefinition. These goldens are
// hand-transcribed from engine/workflows/definitions/* — if a workflow's phases
// or gates change, this test fails loudly, forcing a conscious update of both
// the definition AND the matching builtin SKILL.md frontmatter.

type Golden = {
  slash: string
  initialPhase: string
  gates: Record<string, string> // phase name -> gate.type, in definition order
  tools: string[] // union of every phase's allowedTools (= frontmatter tools[])
}

const GOLDEN: Record<string, Golden> = {
  tdd: {
    slash: '/tdd',
    initialPhase: 'write_test',
    gates: {
      write_test: 'model_done',
      run_test_fail: 'tool_output',
      implement: 'model_done',
      run_test_pass: 'tool_output',
      refactor: 'model_done',
    },
    tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'SubAgent', 'CollectAgent', 'Bash'],
  },
  debug: {
    slash: '/debug',
    initialPhase: 'reproduce',
    gates: { reproduce: 'model_done', hypothesize: 'model_done', isolate: 'model_done', fix: 'model_done', verify: 'model_done' },
    tools: ['Read', 'Glob', 'Grep', 'SubAgent', 'CollectAgent'],
  },
  review: {
    slash: '/review',
    initialPhase: 'gather',
    gates: { gather: 'model_done', analyze: 'model_done', report: 'model_done' },
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'SubAgent', 'CollectAgent'],
  },
  plan: {
    slash: '/plan',
    initialPhase: 'create_plan',
    gates: { create_plan: 'model_done', execute_step: 'model_done', verify_step: 'model_done' },
    tools: ['Read', 'Glob', 'Grep', 'CodeIndex'],
  },
  brainstorm: {
    slash: '/brainstorm',
    initialPhase: 'understand',
    gates: { understand: 'model_done', explore: 'model_done', propose: 'model_done', refine: 'model_done', spec: 'model_done' },
    tools: ['Read', 'Glob', 'Grep', 'Git', 'SubAgent', 'CollectAgent'],
  },
  critique: {
    slash: '/critique',
    initialPhase: 'generate',
    gates: { generate: 'model_done', critique: 'model_done', refine: 'model_done' },
    tools: ['Read', 'Grep', 'Glob', 'SubAgent', 'CollectAgent'],
  },
  research: {
    slash: '/research',
    initialPhase: 'scope',
    gates: { scope: 'model_done', decompose: 'model_done', gather: 'model_done', synthesize: 'model_done', report: 'model_done', index: 'model_done' },
    tools: ['Read', 'Glob', 'Grep', 'CodeIndex', 'WebSearch', 'SubAgent', 'CollectAgent', 'WebFetch', 'Write', 'IndexResearch'],
  },
}

const KNOWN = new Set(ALL_TOOLS.map(t => t.name))

describe('workflow ↔ skill parity', () => {
  it('WORKFLOW_SKILLS covers exactly the 7 built-in workflows', () => {
    expect(Object.keys(WORKFLOW_SKILLS).sort()).toEqual(Object.keys(GOLDEN).sort())
  })

  for (const [name, golden] of Object.entries(GOLDEN)) {
    describe(name, () => {
      it('is a workflow skill resolving to a definition', () => {
        expect(isWorkflowSkill(name)).toBe(true)
        expect(getWorkflowForSkill(name)).toBeDefined()
      })

      it('skill path and slash path resolve to the identical workflow object', () => {
        // Proves `/tdd` and run_skill("tdd") are true aliases — same object,
        // so any behavior is shared, not merely copied.
        expect(getWorkflowForSkill(name)).toBe(getWorkflow(golden.slash))
      })

      it('phase sequence and gates match the golden', () => {
        const wf = getWorkflowForSkill(name)!
        expect(wf.initialPhase).toBe(golden.initialPhase)
        // Same phase names, in the same order.
        expect(Object.keys(wf.phases)).toEqual(Object.keys(golden.gates))
        // Each phase's gate type matches.
        const gateTypes = Object.fromEntries(
          Object.entries(wf.phases).map(([p, phase]) => [p, phase.gate.type]),
        )
        expect(gateTypes).toEqual(golden.gates)
      })

      it('tool union equals the golden and the builtin SKILL.md frontmatter', async () => {
        const wf = getWorkflowForSkill(name)!
        expect(workflowSkillTools(wf)).toEqual(golden.tools)

        const { skills } = await loadSkills({ knownTools: KNOWN })
        const skill = skills.find(s => s.frontmatter.name === name)
        expect(skill).toBeDefined()
        expect(skill!.frontmatter.tools).toEqual(golden.tools)
      })
    })
  }

  it('the tdd workflow drives an identical happy-path traversal through the engine', () => {
    // Drive the skill-resolved workflow through the real WorkflowEngine and
    // assert the forward path (both model_done and tool_output gates) behaves.
    const wf = getWorkflowForSkill('tdd')!
    const engine = new WorkflowEngine()
    engine.start(wf)
    expect(engine.currentPhase?.name).toBe('write_test')

    // write_test: model_done satisfied by end_turn
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('run_test_fail')

    // run_test_fail: tool_output requires a failing Bash result
    expect(engine.checkGate('tool_result', null)).toBe(false)
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: '1 test FAILED' })).toBe(true)
    engine.advance('implement')

    // implement: model_done
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('run_test_pass')

    // run_test_pass: tool_output requires a passing Bash result
    expect(engine.checkGate('tool_result', { tool: 'Bash', output: 'all tests PASS' })).toBe(true)
    engine.advance('refactor')

    // refactor: model_done then done
    expect(engine.checkGate('end_turn', null)).toBe(true)
    engine.advance('done')

    expect(engine.isActive).toBe(false)
    expect(engine.state).toBeNull()
  })
})
