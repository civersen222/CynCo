/**
 * Contract / Definition of Done tools.
 *
 * Provides a lightweight in-memory contract system: the model (or user) defines
 * a set of assertions that must all pass before work is considered complete.
 * Useful for enforcing Definition of Done checklists, acceptance criteria, or
 * task contracts that the model self-verifies.
 */
import type { ToolImpl } from './types.js'

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

export type AssertionStatus = 'pending' | 'passed' | 'failed' | 'skipped'

export interface Assertion {
  text: string
  status: AssertionStatus
  evidence?: string
}

// ---------------------------------------------------------------------------
// ContractState class
// ---------------------------------------------------------------------------

export class ContractState {
  private title: string = ''
  private brief: string = ''
  private assertions: Assertion[] = []
  private active: boolean = false
  /** Number of times the contract has been checked / enforcement rounds run */
  enforcementRounds: number = 0

  private enforcementEnabled: boolean = true

  setEnforcementEnabled(enabled: boolean): void {
    this.enforcementEnabled = enabled
  }

  isEnforcementEnabled(): boolean {
    return this.enforcementEnabled
  }

  /** Create (or replace) the contract with a title, brief, and list of assertion texts. */
  create(title: string, brief: string, assertionTexts: string[]): void {
    this.title = title
    this.brief = brief
    this.assertions = assertionTexts.map(text => ({ text, status: 'pending' as AssertionStatus }))
    this.active = true
    this.enforcementRounds = 0
  }

  /** Mark assertion at `index` as passed, optionally recording evidence. */
  assertPass(index: number, evidence?: string): void {
    if (index < 0 || index >= this.assertions.length) return
    this.assertions[index].status = 'passed'
    if (evidence !== undefined) this.assertions[index].evidence = evidence
  }

  /** Mark assertion at `index` as failed, optionally recording evidence. */
  assertFail(index: number, evidence?: string): void {
    if (index < 0 || index >= this.assertions.length) return
    this.assertions[index].status = 'failed'
    if (evidence !== undefined) this.assertions[index].evidence = evidence
  }

  /** Mark assertion at `index` as skipped, recording a reason. */
  assertSkip(index: number, reason?: string): void {
    if (index < 0 || index >= this.assertions.length) return
    this.assertions[index].status = 'skipped'
    if (reason !== undefined) this.assertions[index].evidence = reason
  }

  /** True when a contract has been created and not yet cleared. */
  isActive(): boolean {
    return this.active
  }

  /**
   * True when a contract is active AND every assertion is either passed or
   * skipped (i.e. no pending or failed assertions remain).
   */
  isComplete(): boolean {
    if (!this.active || this.assertions.length === 0) return false
    return this.assertions.every(a => a.status === 'passed' || a.status === 'skipped')
  }

  /** Count of assertions still in 'pending' status. */
  pendingCount(): number {
    return this.assertions.filter(a => a.status === 'pending').length
  }

  /** Count of assertions in 'failed' status. */
  failedCount(): number {
    return this.assertions.filter(a => a.status === 'failed').length
  }

  /** Return a human-readable status block. */
  getStatus(): string {
    if (!this.active) return 'No active contract.'

    const lines: string[] = []
    lines.push(`Contract: ${this.title}`)
    if (this.brief) lines.push(`Brief: ${this.brief}`)
    lines.push(`Enforcement rounds: ${this.enforcementRounds}`)
    lines.push('')

    this.assertions.forEach((a, i) => {
      const icon =
        a.status === 'passed' ? '[PASS]'
        : a.status === 'failed' ? '[FAIL]'
        : a.status === 'skipped' ? '[SKIP]'
        : '[    ]'
      const evidence = a.evidence ? ` — ${a.evidence}` : ''
      lines.push(`  ${i}. ${icon} ${a.text}${evidence}`)
    })

    lines.push('')
    lines.push(
      `Summary: ${this.assertions.filter(a => a.status === 'passed').length} passed, ` +
      `${this.failedCount()} failed, ` +
      `${this.assertions.filter(a => a.status === 'skipped').length} skipped, ` +
      `${this.pendingCount()} pending`
    )
    lines.push(`Complete: ${this.isComplete() ? 'YES' : 'NO'}`)

    return lines.join('\n')
  }

  /** Clear the contract, resetting all state. */
  clear(): void {
    this.title = ''
    this.brief = ''
    this.assertions = []
    this.active = false
    this.enforcementRounds = 0
  }
}

// ---------------------------------------------------------------------------
// Global singleton
// ---------------------------------------------------------------------------

export const globalContract = new ContractState()

// ---------------------------------------------------------------------------
// Tool: contractCreateTool
// ---------------------------------------------------------------------------

export const contractCreateTool: ToolImpl = {
  name: 'ContractCreate',
  description:
    'Create a Definition of Done contract: a title, brief description, and a list of ' +
    'assertions that must all pass before the task is complete. Replaces any existing contract. ' +
    'Use this at the start of a task to define clear success criteria.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short title for the contract (e.g. "Implement login feature").',
      },
      brief: {
        type: 'string',
        description: 'One-sentence description of what this contract covers.',
      },
      assertions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'List of assertion strings — each is a concrete, verifiable condition that must be satisfied.',
      },
    },
    required: ['title', 'assertions'],
  },
  tier: 'auto',
  execute: async (input) => {
    const title = (input.title as string) || ''
    const brief = (input.brief as string) || ''
    const assertions = (input.assertions as string[]) || []

    if (!title) {
      return { output: 'title is required', isError: true }
    }
    if (!Array.isArray(assertions) || assertions.length === 0) {
      return { output: 'assertions must be a non-empty array of strings', isError: true }
    }

    globalContract.create(title, brief, assertions)
    return {
      output: `Contract created: "${title}" with ${assertions.length} assertion(s).\n\n${globalContract.getStatus()}`,
      isError: false,
    }
  },
}

// ---------------------------------------------------------------------------
// Tool: contractAssertPassTool
// ---------------------------------------------------------------------------

export const contractAssertPassTool: ToolImpl = {
  name: 'ContractAssertPass',
  description:
    'Mark an assertion in the active contract as PASSED. Provide the assertion index (0-based) ' +
    'and optional evidence showing it was met. Use ContractStatus to see current assertion indices.',
  inputSchema: {
    type: 'object',
    properties: {
      index: {
        type: 'number',
        description: 'Zero-based index of the assertion to mark as passed.',
      },
      evidence: {
        type: 'string',
        description: 'Optional evidence or explanation for why this assertion passes.',
      },
    },
    required: ['index'],
  },
  tier: 'auto',
  execute: async (input) => {
    if (!globalContract.isActive()) {
      return { output: 'No active contract. Use ContractCreate first.', isError: true }
    }
    const index = input.index as number
    globalContract.assertPass(index, input.evidence as string | undefined)
    globalContract.enforcementRounds += 1
    return { output: globalContract.getStatus(), isError: false }
  },
}

// ---------------------------------------------------------------------------
// Tool: contractAssertFailTool
// ---------------------------------------------------------------------------

export const contractAssertFailTool: ToolImpl = {
  name: 'ContractAssertFail',
  description:
    'Mark an assertion in the active contract as FAILED. Provide the assertion index (0-based) ' +
    'and optional evidence explaining why it failed. Use ContractStatus to see current assertion indices.',
  inputSchema: {
    type: 'object',
    properties: {
      index: {
        type: 'number',
        description: 'Zero-based index of the assertion to mark as failed.',
      },
      evidence: {
        type: 'string',
        description: 'Optional evidence or explanation for why this assertion fails.',
      },
    },
    required: ['index'],
  },
  tier: 'auto',
  execute: async (input) => {
    if (!globalContract.isActive()) {
      return { output: 'No active contract. Use ContractCreate first.', isError: true }
    }
    const index = input.index as number
    globalContract.assertFail(index, input.evidence as string | undefined)
    globalContract.enforcementRounds += 1
    return { output: globalContract.getStatus(), isError: false }
  },
}

// ---------------------------------------------------------------------------
// Tool: contractStatusTool
// ---------------------------------------------------------------------------

export const contractStatusTool: ToolImpl = {
  name: 'ContractStatus',
  description:
    'Show the current status of the active Definition of Done contract, including all assertions ' +
    'and their pass/fail/pending/skipped state. Returns "No active contract." if none exists.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  tier: 'auto',
  execute: async (_input) => {
    return { output: globalContract.getStatus(), isError: false }
  },
}
