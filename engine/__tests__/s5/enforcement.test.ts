/**
 * S5 Enforcement tests.
 *
 * These test the hard enforcement behaviors that the conversation loop
 * applies based on S5Decision output: tool filtering, model switching,
 * and governance.recommendation emission.
 */

import { describe, expect, it } from 'bun:test'
import { RuleBasedS5 } from '../../s5/ruleBasedS5.js'
import { S5Orchestrator } from '../../s5/orchestrator.js'
import type { OrchestratorInput } from '../../s5/orchestrator.js'
import type { S5Decision, S5Input } from '../../s5/types.js'
import type { GovernanceReport } from '../../vsm/types.js'

// Simulates the toolDefs array as built in conversationLoop
type ToolDef = { name: string; description: string; inputJSONSchema: { type: 'object'; properties: Record<string, unknown> } }

function makeTool(name: string): ToolDef {
  return { name, description: `${name} tool`, inputJSONSchema: { type: 'object', properties: {} } }
}

const FULL_TOOLS: ToolDef[] = [
  makeTool('Read'),
  makeTool('Glob'),
  makeTool('Grep'),
  makeTool('Edit'),
  makeTool('Write'),
  makeTool('Bash'),
  makeTool('Git'),
  makeTool('Ls'),
  makeTool('WebFetch'),
  makeTool('CodeSearch'),
]

function makeGovernance(overrides: Partial<GovernanceReport> = {}): GovernanceReport {
  return {
    status: 'healthy',
    varietyBalance: 'balanced',
    varietyRatio: 1.0,
    s3s4Balance: 'balanced',
    algedonicAlerts: 0,
    stuckTurns: 0,
    consecutiveUnstable: 0,
    modelLatencyTrend: 'stable',
    toolSuccessRate: 1.0,
    ...overrides,
  }
}

function makeInput(overrides: Partial<OrchestratorInput> = {}): OrchestratorInput {
  return {
    userMessage: 'write some tests',
    activeWorkflow: null,
    currentPhase: null,
    contextUsagePercent: 0.4,
    governance: makeGovernance(),
    recentToolResults: [],
    availableModels: ['qwen3:8b'],
    turnCount: 3,
    ...overrides,
  }
}

/**
 * Simulates the S5 enforcement logic from conversationLoop.ts:
 * - If decision.tools is set, filter toolDefs to only those tools
 * - If decision.tools is null, no filtering
 */
function applyS5ToolFilter(toolDefs: ToolDef[], decision: S5Decision): ToolDef[] {
  if (decision.tools) {
    const allowed = new Set(decision.tools)
    return toolDefs.filter(t => allowed.has(t.name))
  }
  return toolDefs
}

/**
 * Simulates workflow + S5 combined filtering:
 * workflow restricts first, then S5 restricts further.
 */
function applyWorkflowThenS5(
  toolDefs: ToolDef[],
  workflowAllowed: string[] | null,
  decision: S5Decision,
): ToolDef[] {
  // Workflow filtering (happens first in conversationLoop ~line 478)
  let filtered = toolDefs
  if (workflowAllowed) {
    filtered = filtered.filter(t => workflowAllowed.includes(t.name))
  }
  // S5 filtering (happens after, ~line 631)
  return applyS5ToolFilter(filtered, decision)
}

describe('S5 Enforcement: Tool Filtering', () => {
  it('filters tools to only those in S5Decision.tools', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: ['Read', 'Glob', 'Grep', 'Ls'],
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'halted — read-only mode',
      ruleIds: ['C1'],
    }

    const result = applyS5ToolFilter([...FULL_TOOLS], decision)
    const names = result.map(t => t.name)
    expect(names).toEqual(['Read', 'Glob', 'Grep', 'Ls'])
    // Verify write tools are excluded
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
  })

  it('null tools means no filtering — all tools survive', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'no restrictions needed',
    }

    const result = applyS5ToolFilter([...FULL_TOOLS], decision)
    expect(result.length).toBe(FULL_TOOLS.length)
    expect(result.map(t => t.name)).toEqual(FULL_TOOLS.map(t => t.name))
  })

  it('workflow tools intersect with S5 tools — most restrictive wins', () => {
    // Workflow allows: Read, Glob, Grep, Edit, Write
    const workflowAllowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write']
    // S5 allows: Read, Glob, Grep, Ls (read-only)
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: ['Read', 'Glob', 'Grep', 'Ls'],
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'restrict to read-only',
      ruleIds: ['C1'],
    }

    const result = applyWorkflowThenS5([...FULL_TOOLS], workflowAllowed, decision)
    const names = result.map(t => t.name)
    // Intersection: Read, Glob, Grep (Ls not in workflow, Edit/Write not in S5)
    expect(names).toEqual(['Read', 'Glob', 'Grep'])
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Ls') // Ls was not in workflow
  })

  it('S5 halted -> only read tools survive full pipeline', async () => {
    const orchestrator = new S5Orchestrator(new RuleBasedS5())
    const decision = await orchestrator.makeDecision(makeInput({
      governance: makeGovernance({ status: 'halted' }),
    }))

    // C1 rule should fire and restrict to read-only
    expect(decision.tools).toBeDefined()
    expect(decision.ruleIds).toContain('C1')

    // Apply enforcement
    const result = applyS5ToolFilter([...FULL_TOOLS], decision)
    const names = result.map(t => t.name)
    // Only read-only tools should survive
    for (const name of names) {
      expect(['Read', 'Glob', 'Grep', 'Ls']).toContain(name)
    }
    // Write tools must be gone
    expect(names).not.toContain('Edit')
    expect(names).not.toContain('Write')
    expect(names).not.toContain('Bash')
  })

  it('empty tools array removes ALL tools', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: [],
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'total lockdown',
    }

    const result = applyS5ToolFilter([...FULL_TOOLS], decision)
    expect(result.length).toBe(0)
  })
})

describe('S5 Enforcement: Model Switch', () => {
  it('decision with model different from current triggers switch', () => {
    const currentModel = 'qwen3:8b'
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: 'qwen3:32b',
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'upgrade for complex task',
    }

    // Simulate the enforcement check
    const shouldSwitch = decision.model !== null && decision.model !== currentModel
    expect(shouldSwitch).toBe(true)
  })

  it('null model means no switch', () => {
    const currentModel = 'qwen3:8b'
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'no change needed',
    }

    const shouldSwitch = decision.model !== null && decision.model !== currentModel
    expect(shouldSwitch).toBe(false)
  })

  it('same model means no switch', () => {
    const currentModel = 'qwen3:8b'
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: 'qwen3:8b',
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'keep current model',
    }

    const shouldSwitch = decision.model !== null && decision.model !== currentModel
    expect(shouldSwitch).toBe(false)
  })
})

describe('S5 Enforcement: Governance Recommendation', () => {
  it('warning-tier rules produce governance.recommendation events', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: ['Read', 'Glob', 'Grep', 'Edit'],
      contextAction: 'warn',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'Variety imbalance detected. Diversify tool usage.',
      ruleIds: ['W1', 'W3'],
    }

    // Simulate the enforcement logic
    const warningRuleIds = (decision.ruleIds ?? []).filter(id => id.startsWith('W'))
    expect(warningRuleIds.length).toBeGreaterThan(0)
    expect(warningRuleIds).toContain('W1')
    expect(warningRuleIds).toContain('W3')

    // Verify the event would be well-formed
    const event = {
      type: 'governance.recommendation' as const,
      requestId: 'test-uuid',
      severity: 'warning' as const,
      signal: warningRuleIds[0],
      title: decision.reasoning.split('.')[0],
      description: decision.reasoning,
      action: {
        model: decision.model,
        tools: decision.tools,
        contextAction: decision.contextAction,
        revert: decision.revert,
        priority: decision.priority,
      },
      autoApplyAfterMs: decision.revert ? undefined : 60000,
    }

    expect(event.signal).toBe('W1')
    expect(event.title).toBe('Variety imbalance detected')
    expect(event.autoApplyAfterMs).toBe(60000)
  })

  it('critical-tier rules do NOT produce governance.recommendation', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: ['Read', 'Glob', 'Grep', 'Ls'],
      contextAction: 'none',
      spawnAgent: null,
      priority: 's3',
      reasoning: 'System halted. Read-only mode.',
      ruleIds: ['C1'],
    }

    const warningRuleIds = (decision.ruleIds ?? []).filter(id => id.startsWith('W'))
    expect(warningRuleIds.length).toBe(0)
  })

  it('revert decisions suppress autoApplyAfterMs', () => {
    const decision: S5Decision = {
      workflow: null,
      advancePhase: null,
      model: null,
      tools: null,
      contextAction: 'none',
      spawnAgent: null,
      priority: 'balanced',
      reasoning: 'Revert to previous state.',
      revert: true,
      ruleIds: ['W5'],
    }

    const warningRuleIds = (decision.ruleIds ?? []).filter(id => id.startsWith('W'))
    expect(warningRuleIds.length).toBe(1)

    const autoApply = decision.revert ? undefined : 60000
    expect(autoApply).toBeUndefined()
  })
})

describe('S5 Enforcement: Orchestrator Input Passthrough', () => {
  it('passes governance signal fields through to S5Input', async () => {
    let capturedInput: S5Input | null = null
    const mockS5 = {
      name: 'MockCapture',
      decide: async (input: S5Input) => {
        capturedInput = input
        return {
          workflow: null,
          advancePhase: null,
          model: null,
          tools: null,
          contextAction: 'none' as const,
          spawnAgent: null,
          priority: 'balanced' as const,
          reasoning: 'captured',
        }
      },
    }

    const orchestrator = new S5Orchestrator(mockS5)
    await orchestrator.makeDecision(makeInput({
      varietyBalance: 'overload',
      varietyRatio: 0.3,
      homeostatStable: false,
      homeostatConsecutiveUnstable: 5,
      driftDetected: true,
      driftDirection: 'degrading',
      performanceHealth: 'critical',
      productivityRatio: 0.2,
      recommendedToolMode: 'read_only',
      heterarchyAuthority: 's5',
    }))

    expect(capturedInput).not.toBeNull()
    expect(capturedInput!.varietyBalance).toBe('overload')
    expect(capturedInput!.varietyRatio).toBe(0.3)
    expect(capturedInput!.homeostatStable).toBe(false)
    expect(capturedInput!.homeostatConsecutiveUnstable).toBe(5)
    expect(capturedInput!.driftDetected).toBe(true)
    expect(capturedInput!.driftDirection).toBe('degrading')
    expect(capturedInput!.performanceHealth).toBe('critical')
    expect(capturedInput!.productivityRatio).toBe(0.2)
    expect(capturedInput!.recommendedToolMode).toBe('read_only')
    expect(capturedInput!.heterarchyAuthority).toBe('s5')
  })

  it('defaults governance signal fields when not provided', async () => {
    let capturedInput: S5Input | null = null
    const mockS5 = {
      name: 'MockCapture',
      decide: async (input: S5Input) => {
        capturedInput = input
        return {
          workflow: null,
          advancePhase: null,
          model: null,
          tools: null,
          contextAction: 'none' as const,
          spawnAgent: null,
          priority: 'balanced' as const,
          reasoning: 'defaults',
        }
      },
    }

    const orchestrator = new S5Orchestrator(mockS5)
    // No governance signal fields — should use defaults
    await orchestrator.makeDecision(makeInput())

    expect(capturedInput).not.toBeNull()
    expect(capturedInput!.varietyBalance).toBe('balanced')
    expect(capturedInput!.varietyRatio).toBe(1.0)
    expect(capturedInput!.homeostatStable).toBe(true)
    expect(capturedInput!.homeostatConsecutiveUnstable).toBe(0)
    expect(capturedInput!.driftDetected).toBe(false)
    expect(capturedInput!.driftDirection).toBeNull()
    expect(capturedInput!.performanceHealth).toBe('healthy')
    expect(capturedInput!.productivityRatio).toBe(0.8)
    expect(capturedInput!.recommendedToolMode).toBeNull()
    expect(capturedInput!.heterarchyAuthority).toBeNull()
  })
})
