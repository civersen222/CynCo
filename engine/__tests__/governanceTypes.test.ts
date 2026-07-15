/**
 * Task B1: Verify GovernanceReport and S5Input extended types.
 *
 * Checks that:
 * - GovernanceReport includes agreementRatio, observerDivergence, axiomHealth
 * - S5Input includes agreementRatio and observerDivergence
 * - CyberneticsGovernance.getReport() returns the new fields
 * - Orchestrator passes new fields from governance to S5Input
 */

import { describe, expect, it } from 'bun:test'
import type { GovernanceReport, AxiomHealth } from '../vsm/types.js'
import type { S5Input } from '../s5/types.js'
import { CyberneticsGovernance } from '../vsm/cyberneticsGovernance.js'
import { S5Orchestrator } from '../s5/orchestrator.js'
import { RuleBasedS5 } from '../s5/ruleBasedS5.js'
import type { OrchestratorInput } from '../s5/orchestrator.js'

// ─── GovernanceReport shape ───────────────────────────────────────

describe('GovernanceReport extended fields', () => {
  it('includes agreementRatio as a number', () => {
    const report: GovernanceReport = {
      status: 'healthy',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      varietyWindowed: 0,
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 1.0,
      agreementRatio: 0.85,
      observerDivergence: null,
      axiomHealth: { holding: 3, total: 3, violations: [] },
      recentToolNames: [],
      predictions: { open: 0, completed: 0, stats: [] },
      s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
      heterarchy: { context: 'normal' as const, commander: 'S3', shifted: false },
    }
    expect(typeof report.agreementRatio).toBe('number')
    expect(report.agreementRatio).toBe(0.85)
  })

  it('includes observerDivergence as number | null', () => {
    const withNull: GovernanceReport = {
      status: 'healthy',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      varietyWindowed: 0,
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 1.0,
      agreementRatio: 1.0,
      observerDivergence: null,
      axiomHealth: { holding: 0, total: 0, violations: [] },
      recentToolNames: [],
      predictions: { open: 0, completed: 0, stats: [] },
      s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
      heterarchy: { context: 'normal' as const, commander: 'S3', shifted: false },
    }
    expect(withNull.observerDivergence).toBeNull()

    const withValue: GovernanceReport = { ...withNull, observerDivergence: 0.3 }
    expect(typeof withValue.observerDivergence).toBe('number')
    expect(withValue.observerDivergence).toBe(0.3)
  })

  it('includes axiomHealth with holding, total, violations', () => {
    const axiom: AxiomHealth = { holding: 2, total: 3, violations: ['axiom_1'] }
    const report: GovernanceReport = {
      status: 'warning',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      varietyWindowed: 0,
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 0.9,
      agreementRatio: 0.7,
      observerDivergence: 0.2,
      axiomHealth: axiom,
      recentToolNames: [],
      predictions: { open: 0, completed: 0, stats: [] },
      s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
      heterarchy: { context: 'normal' as const, commander: 'S3', shifted: false },
    }
    expect(report.axiomHealth.holding).toBe(2)
    expect(report.axiomHealth.total).toBe(3)
    expect(report.axiomHealth.violations).toEqual(['axiom_1'])
  })
})

// ─── S5Input extended fields ──────────────────────────────────────

describe('S5Input extended fields', () => {
  it('includes agreementRatio as a number', () => {
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.4,
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:8b'],
      turnCount: 1,
      recentToolResults: [],
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
      agreementRatio: 0.9,
      observerDivergence: null,
      demotedTools: [],
      promptDifficulty: 'unknown',
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
    }
    expect(typeof input.agreementRatio).toBe('number')
    expect(input.agreementRatio).toBe(0.9)
  })

  it('includes observerDivergence as number | null', () => {
    const input: S5Input = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.4,
      governanceStatus: 'healthy',
      s3s4Balance: 'balanced',
      modelLatencyTrend: 'stable',
      availableModels: ['qwen3:8b'],
      turnCount: 1,
      recentToolResults: [],
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      homeostatStable: true,
      homeostatConsecutiveUnstable: 0,
      driftDetected: false,
      driftDirection: null,
      performanceHealth: 'healthy',
      productivityRatio: 0.8,
      recommendedToolMode: null,
      heterarchyAuthority: null,
      agreementRatio: 1.0,
      observerDivergence: 0.15,
      demotedTools: [],
      promptDifficulty: 'unknown',
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
    }
    expect(typeof input.observerDivergence).toBe('number')
    expect(input.observerDivergence).toBe(0.15)
  })
})

// ─── CyberneticsGovernance.getReport() ───────────────────────────

describe('CyberneticsGovernance.getReport() new fields', () => {
  it('returns agreementRatio as a number', () => {
    const gov = new CyberneticsGovernance()
    const report = gov.getReport()
    expect(typeof report.agreementRatio).toBe('number')
    expect(report.agreementRatio).toBeGreaterThanOrEqual(0)
    expect(report.agreementRatio).toBeLessThanOrEqual(1)
  })

  it('returns observerDivergence as null (placeholder)', () => {
    const gov = new CyberneticsGovernance()
    const report = gov.getReport()
    expect(report.observerDivergence).toBeNull()
  })

  it('returns axiomHealth with zero placeholder values', () => {
    const gov = new CyberneticsGovernance()
    const report = gov.getReport()
    expect(report.axiomHealth).toBeDefined()
    expect(report.axiomHealth.holding).toBe(0)
    expect(report.axiomHealth.total).toBe(0)
    expect(Array.isArray(report.axiomHealth.violations)).toBe(true)
    expect(report.axiomHealth.violations).toHaveLength(0)
  })
})

// ─── S5Orchestrator passes new fields to S5Input ─────────────────

describe('S5Orchestrator passes agreementRatio and observerDivergence', () => {
  it('extracts agreementRatio from governance and passes to S5Input', async () => {
    let capturedInput: S5Input | null = null
    const mockS5 = {
      name: 'MockS5',
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
          reasoning: 'test',
        }
      },
    }

    const orchestrator = new S5Orchestrator(mockS5)
    const govReport: GovernanceReport = {
      status: 'healthy',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      varietyWindowed: 0,
      taskError: null,
      errorTrend: null,
      fingerprintAlarm: null,
      infoGain: null,
      progressRate: null,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 1.0,
      agreementRatio: 0.75,
      observerDivergence: 0.1,
      axiomHealth: { holding: 0, total: 0, violations: [] },
      recentToolNames: [],
      predictions: { open: 0, completed: 0, stats: [] },
      s4: { scores: null, composite: null, reflectionCount: 0, taskType: 'simple_query', taskComplexity: 1 },
      heterarchy: { context: 'normal' as const, commander: 'S3', shifted: false },
    }

    const orchInput: OrchestratorInput = {
      userMessage: 'test message',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.3,
      governance: govReport,
      recentToolResults: [],
      availableModels: ['qwen3:8b'],
      turnCount: 2,
    }

    await orchestrator.makeDecision(orchInput)

    expect(capturedInput).not.toBeNull()
    expect((capturedInput as S5Input).agreementRatio).toBe(0.75)
    expect((capturedInput as S5Input).observerDivergence).toBe(0.1)
  })

  it('defaults agreementRatio to 1.0 when governance field missing', async () => {
    let capturedInput: S5Input | null = null
    const mockS5 = {
      name: 'MockS5',
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
          reasoning: 'test',
        }
      },
    }

    const orchestrator = new S5Orchestrator(mockS5)
    // Use partial governance that lacks the new fields (simulates legacy code)
    const legacyGov = {
      status: 'healthy',
      varietyBalance: 'balanced',
      varietyRatio: 1.0,
      s3s4Balance: 'balanced',
      algedonicAlerts: 0,
      stuckTurns: 0,
      consecutiveUnstable: 0,
      modelLatencyTrend: 'stable',
      toolSuccessRate: 1.0,
    } as GovernanceReport

    const orchInput: OrchestratorInput = {
      userMessage: 'test',
      activeWorkflow: null,
      currentPhase: null,
      contextUsagePercent: 0.3,
      governance: legacyGov,
      recentToolResults: [],
      availableModels: ['qwen3:8b'],
      turnCount: 1,
    }

    await orchestrator.makeDecision(orchInput)

    expect(capturedInput).not.toBeNull()
    expect((capturedInput as S5Input).agreementRatio).toBe(1.0)
    expect((capturedInput as S5Input).observerDivergence).toBeNull()
  })
})
