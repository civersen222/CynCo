/**
 * ModelS5 — fine-tuned model caller for S5 decisions.
 *
 * Calls an Ollama /api/generate endpoint with an S5-specialized model.
 * Falls back to RuleBasedS5 on any connection, timeout, or parse error.
 */

import type { S5Interface, S5Input, S5Decision } from './types.js'

// ─── Defaults ────────────────────────────────────────────────────

const DEFAULT_S5_DECISION: S5Decision = {
  workflow: null,
  advancePhase: null,
  model: null,
  tools: null,
  contextAction: 'none',
  spawnAgent: null,
  priority: 'balanced',
  reasoning: 'default fallback decision',
}

// ─── RuleBasedS5 (inline fallback) ───────────────────────────────

class RuleBasedS5 implements S5Interface {
  readonly name = 'RuleBasedS5'

  async decide(input: S5Input): Promise<S5Decision> {
    let contextAction: S5Decision['contextAction'] = 'none'
    if (input.contextUsagePercent > 0.9) {
      contextAction = 'compact'
    } else if (input.contextUsagePercent > 0.75) {
      contextAction = 'warn'
    }

    let priority: S5Decision['priority'] = 'balanced'
    if (input.s3s4Balance === 's3_dominant') {
      priority = 's4'
    } else if (input.s3s4Balance === 's4_dominant') {
      priority = 's3'
    }

    return {
      ...DEFAULT_S5_DECISION,
      contextAction,
      priority,
      reasoning: `rule-based: governance=${input.governanceStatus}, context=${(input.contextUsagePercent * 100).toFixed(0)}%`,
    }
  }
}

// ─── ModelS5 ──────────────────────────────────────────────────────

export type ModelS5Config = {
  model: string
  baseUrl: string
  timeout?: number
}

export class ModelS5 implements S5Interface {
  readonly name = 'ModelS5'
  private fallback: RuleBasedS5
  private config: Required<ModelS5Config>

  constructor(config: ModelS5Config) {
    this.config = {
      model: config.model,
      baseUrl: config.baseUrl,
      timeout: config.timeout ?? 10_000,
    }
    this.fallback = new RuleBasedS5()
  }

  async decide(input: S5Input): Promise<S5Decision> {
    try {
      const prompt = this.formatPrompt(input)
      const body = JSON.stringify({
        model: this.config.model,
        prompt,
        stream: false,
        format: 'json',
      })

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.config.timeout)

      let response: Response
      try {
        response = await fetch(`${this.config.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        return this.fallback.decide(input)
      }

      const json = await response.json() as { response?: string }
      const text = json.response ?? ''
      return this.parseResponse(text)
    } catch {
      return this.fallback.decide(input)
    }
  }

  formatPrompt(input: S5Input): string {
    const toolSummary = input.recentToolResults
      .map(r => `${r.tool}:${r.success ? 'ok' : 'fail'}`)
      .join(', ')

    return [
      'You are the S5 policy intelligence layer for a local coding assistant.',
      'Given the current system state, return a JSON decision object.',
      '',
      `User message: ${input.userMessage}`,
      `Active workflow: ${input.activeWorkflow ?? 'none'}`,
      `Current phase: ${input.currentPhase ?? 'none'}`,
      `Context usage: ${(input.contextUsagePercent * 100).toFixed(1)}%`,
      `Recent tools: ${toolSummary || 'none'}`,
      `Governance: ${input.governanceStatus}`,
      `S3/S4 balance: ${input.s3s4Balance}`,
      `Model latency trend: ${input.modelLatencyTrend}`,
      `Available models: ${input.availableModels.join(', ')}`,
      `Turn count: ${input.turnCount}`,
      '',
      'Return JSON with fields: workflow, advancePhase, model, tools, contextAction, spawnAgent, priority, reasoning.',
    ].join('\n')
  }

  parseResponse(text: string): S5Decision {
    try {
      // Try extracting JSON from the text (model may wrap it in prose)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { ...DEFAULT_S5_DECISION, reasoning: 'no JSON found in response' }

      const parsed = JSON.parse(jsonMatch[0]) as Partial<S5Decision>

      return {
        workflow: parsed.workflow ?? null,
        advancePhase: parsed.advancePhase ?? null,
        model: parsed.model ?? null,
        tools: Array.isArray(parsed.tools) ? parsed.tools : null,
        contextAction: isValidContextAction(parsed.contextAction) ? parsed.contextAction : 'none',
        spawnAgent: parsed.spawnAgent ?? null,
        priority: isValidPriority(parsed.priority) ? parsed.priority : 'balanced',
        reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'parsed from model',
      }
    } catch {
      return { ...DEFAULT_S5_DECISION, reasoning: 'parse error — defaulting' }
    }
  }
}

// ─── Type Guards ─────────────────────────────────────────────────

function isValidContextAction(v: unknown): v is S5Decision['contextAction'] {
  return v === 'none' || v === 'compact' || v === 'warn'
}

function isValidPriority(v: unknown): v is S5Decision['priority'] {
  return v === 's3' || v === 's4' || v === 'balanced'
}
