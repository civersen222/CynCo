/**
 * Contract / Definition of Done tools.
 *
 * Provides a lightweight in-memory contract system: the model (or user) defines
 * a set of assertions that must all pass before work is considered complete.
 * Useful for enforcing Definition of Done checklists, acceptance criteria, or
 * task contracts that the model self-verifies.
 */
import type { ToolImpl } from './types.js'
import { assertionCheck, gitProbe, verifyAssertion, type AssertionCheck } from './contractVerify.js'
import { sessionContracts, verdictOf } from '../memory/promotionGate.js'

// ---------------------------------------------------------------------------
// Core data types
// ---------------------------------------------------------------------------

export type AssertionStatus = 'pending' | 'passed' | 'failed' | 'skipped'

export interface Assertion {
  text: string
  status: AssertionStatus
  evidence?: string
  /**
   * The check to run, when it must be withheld from `text`.
   *
   * Finding (ah)/(aj). A mission's gate is held out: the agent must not be told
   * what grades it, because a visible gate can be tuned to. The 2026-07-30 fix
   * achieved that by replacing the assertion text with prose — which also
   * deleted the command from the only place two other mechanisms looked for it.
   * `assertionCheck` stopped recognising the assertion (so ContractAssertPass
   * verified nothing and the model self-certified `taskCompleted`), and
   * `harnessGatePaths` stopped finding the gate script (so the file that scores
   * the run became editable by the run).
   *
   * Withholding is a property of what the model READS, so it belongs in the
   * text — and nowhere else. This field is the same claim addressed to the
   * engine. No rendering path touches it, which is why the leak cannot come
   * back one forgotten `getStatus()` at a time.
   */
  command?: string
}

/**
 * How a harness supplies one assertion: plain text whose claim is legible in
 * the text itself, or a redacted text paired with the command that actually
 * decides it.
 */
export type HarnessAssertion = string | { text: string; command: string }

/**
 * Who wrote this contract. 'harness' means a person authored it — a mission
 * brief's check script, which IS the specification. 'auto' covers everything
 * else: the loop synthesizing assertions from the shape of a user message, the
 * model calling ContractCreate on itself, the vibe controller deriving them
 * from locked decisions. None of those state what was asked for; they state
 * file mechanics, or the model's own opinion of its job.
 *
 * The reward labeler has to tell them apart. Satisfying an auto-contract is not
 * evidence the task was done — on the L2b run one certified taskCompleted=1 for
 * work that skipped every test the brief demanded.
 */
export type ContractOrigin = 'auto' | 'harness'

export interface ContractSnapshot {
  title: string
  brief: string
  active: boolean
  complete: boolean
  origin: ContractOrigin
  assertions: Assertion[]
}

// ---------------------------------------------------------------------------
// ContractState class
// ---------------------------------------------------------------------------

export class ContractState {
  private title: string = ''
  private brief: string = ''
  private assertions: Assertion[] = []
  private active: boolean = false
  private origin: ContractOrigin = 'auto'
  /**
   * HEAD at the moment the contract was created. Without it "Changes committed
   * to git" is unfalsifiable — a repo with any history satisfies it. The live
   * failure this guards against: a run that made zero edits passed that
   * assertion citing 1166a60, a commit made before the task began.
   */
  private baseline: string | null = null
  /** Number of times the contract has been checked / enforcement rounds run */
  enforcementRounds: number = 0

  private enforcementEnabled: boolean = true

  setEnforcementEnabled(enabled: boolean): void {
    this.enforcementEnabled = enabled
  }

  isEnforcementEnabled(): boolean {
    return this.enforcementEnabled
  }

  /** Create (or replace) the contract with a title, brief, and list of assertions. */
  create(title: string, brief: string, assertionTexts: HarnessAssertion[], origin: ContractOrigin = 'auto'): void {
    // File the outgoing contract's verdict before it is overwritten. Promotion
    // of a session's learnings is decided once, at shutdown, for the whole
    // session; a gate that read only the live contract would let one trivial
    // final task launder the learnings of the failed tasks before it. See
    // memory/promotionGate.ts.
    if (this.assertions.length > 0) sessionContracts.record(verdictOf(this))
    this.title = title
    this.brief = brief
    this.assertions = assertionTexts.map(a =>
      typeof a === 'string'
        ? { text: a, status: 'pending' as AssertionStatus }
        : { text: a.text, command: a.command, status: 'pending' as AssertionStatus })
    this.origin = origin
    this.active = true
    this.baseline = null
    this.enforcementRounds = 0
    this.enforcementEnabled = true
  }

  /** Record the repository state this contract's work will be measured against. */
  setBaseline(head: string | null): void {
    this.baseline = head
  }

  getBaseline(): string | null {
    return this.baseline
  }

  /** Assertion text at `index`, or null when out of range. */
  assertionText(index: number): string | null {
    return this.assertions[index]?.text ?? null
  }

  /**
   * The whole assertion at `index`, including a withheld `command`.
   *
   * Separate from `assertionText` because a caller that only wants to SHOW the
   * assertion must not be handed the field it is supposed to withhold.
   */
  assertionAt(index: number): Assertion | null {
    return this.assertions[index] ?? null
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

  /**
   * Enforcement budget exhausted with work still unverified. Force every
   * pending assertion to failed so the contract RESOLVES rather than silently
   * expiring — an unverified run must never report success. Returns the texts
   * of the assertions that were forced, for reporting.
   */
  resolveUnverified(reason: string = 'enforcement budget exhausted — never verified'): string[] {
    const forced: string[] = []
    for (const a of this.assertions) {
      if (a.status === 'pending') {
        a.status = 'failed'
        a.evidence = reason
        forced.push(a.text)
      }
    }
    if (forced.length > 0) {
      this.active = false
    }
    return forced
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
    if (!this.active && this.assertions.length === 0) return 'No active contract.'

    const lines: string[] = []
    lines.push(`Contract: ${this.title}`)
    // Where the assertions came from. Without this the two kinds are
    // indistinguishable, and on Gilded L4.1e the agent read 35 harness
    // assertions, concluded they "appear auto-generated", and replaced them.
    // An inferred contract IS a guess and should be treated as one; a
    // harness contract is what the task will be judged against.
    lines.push(this.origin === 'harness'
      ? 'Source: supplied with the task — this is the specification your work is judged against, not a guess. It cannot be replaced.'
      : 'Source: inferred by the engine from the request — approximate.')
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

  /** Who authored these assertions. 'harness' means a person did. */
  getOrigin(): ContractOrigin {
    return this.origin
  }

  /**
   * The assertion texts, for consumers that need to know what the task requires
   * rather than how far along it is — the tool floor reads these to decide
   * whether the offered tool set can achieve the contract at all.
   */
  getAssertionTexts(): string[] {
    return this.assertions.map(a => a.text)
  }

  /** Return a deep-copied, serializable snapshot of the contract state. */
  snapshot(): ContractSnapshot {
    return {
      title: this.title,
      brief: this.brief,
      active: this.active,
      complete: this.isComplete(),
      origin: this.origin,
      assertions: this.assertions.map(a => ({ ...a })),
    }
  }

  /** Clear the contract, resetting all state. */
  clear(): void {
    this.title = ''
    this.brief = ''
    this.assertions = []
    this.active = false
    this.origin = 'auto'
    this.baseline = null
    this.enforcementRounds = 0
    this.enforcementEnabled = true
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
  core: true,
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

    // A harness contract is the task author's specification. Replacing it is
    // rewriting the yardstick the work is measured by — on Gilded L4.1e the
    // agent judged 35 harness assertions "auto-generated", swapped in 5 of its
    // own, and marked them all passed. It had in fact done the work, and the
    // labeler refused to credit a self-authored contract (taskCompleted came
    // back 'unknown'), so that run lost only its measurement. The next one
    // might delete a gate it could not pass instead.
    if (globalContract.isActive() && globalContract.getOrigin() === 'harness') {
      return {
        output:
          'This contract came with the task and cannot be replaced — it is the ' +
          'specification your work is measured against, not a draft.\n\n' +
          'If an assertion is wrong, unsatisfiable, or contradicts the task, mark ' +
          'that one with ContractAssertFail giving the reason, and say so in your ' +
          'answer. Do not restate the criteria in your own words: an assertion you ' +
          'wrote and then passed proves nothing about the task you were given.\n\n' +
          globalContract.getStatus(),
        isError: true,
      }
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
    'and optional evidence showing it was met. Use ContractStatus to see current assertion indices. ' +
    'Assertions about files and commits are checked against the repository — the claim is rejected ' +
    'if the repository contradicts it, whatever the evidence says.',
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
  core: true,
  execute: async (input, cwd) => {
    if (!globalContract.isActive()) {
      return { output: 'No active contract. Use ContractCreate first.', isError: true }
    }
    const index = input.index as number
    let evidence = input.evidence as string | undefined

    // The engine or the harness wrote these assertions, so it knows which of
    // them the workspace can answer. Where it can, the workspace's answer wins:
    // a contradicted claim is refused outright rather than recorded as passed on
    // the strength of the model's prose.
    //
    // A command check only runs for a 'harness' contract. Assertion text is
    // model-writable through ContractCreate, and executing a string the model
    // authored would be an unapproved shell call wearing a verification's
    // clothes. A person's check script is a specification; the agent's is a wish.
    // A withheld command IS the assertion — the redacted text is only what the
    // model is allowed to read. Reading the check out of the text alone is what
    // made every mission since 2026-07-30 self-certified (finding (ah)): the
    // text no longer parsed, so nothing ran and the model's word stood.
    const a = globalContract.assertionAt(index)
    const text = a?.text ?? null
    // `withheld` travels with the check because only this site knows the
    // difference: `a.command` is the held-out gate, carried BESIDE a redacted
    // text, while `assertionCheck(text)` recovers a command the text already
    // names out loud. Without the flag the failure message leaked the gate
    // (F34).
    let check: AssertionCheck | null = a?.command
      ? { kind: 'command', command: a.command, withheld: true }
      : text ? assertionCheck(text) : null
    if (check?.kind === 'command' && globalContract.getOrigin() !== 'harness') check = null
    if (check) {
      const v = await verifyAssertion(check, gitProbe(cwd), globalContract.getBaseline())
      if (v.status === 'contradicted') {
        return {
          output:
            `Assertion ${index} was NOT marked passed — the repository contradicts it.\n\n` +
            `  Assertion: ${text}\n` +
            `  Repository: ${v.detail}\n\n` +
            `Do the work, then assert it. If the assertion cannot be satisfied, use ContractAssertFail.`,
          isError: true,
        }
      }
      // F35. The check ran and was killed, so it said nothing — but a pass here
      // would be the model's own word on the one assertion it is least entitled
      // to give it on. Refuse like a contradiction, explain like the absence it
      // is, and do not tell the model to change work that was never measured.
      if (v.status === 'unmeasured') {
        return {
          output:
            `Assertion ${index} was NOT marked passed — it could not be measured.\n\n` +
            `  Assertion: ${text}\n` +
            `  Check: ${v.detail}\n\n` +
            `This says nothing about whether your work is correct. Do not change ` +
            `working code on the strength of it. Carry on with the task; a check ` +
            `too slow to finish in a turn is the dispatcher's to run at the end.`,
          isError: true,
        }
      }
      if (v.status === 'unverifiable') {
        evidence = `[unverified: ${v.detail}] ${evidence ?? ''}`.trim()
      }
    }

    globalContract.assertPass(index, evidence)
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
  core: true,
  execute: async (input) => {
    if (!globalContract.isActive()) {
      return { output: 'No active contract. Use ContractCreate first.', isError: true }
    }
    const index = input.index as number
    globalContract.assertFail(index, input.evidence as string | undefined)
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
  core: true,
  execute: async (_input) => {
    return { output: globalContract.getStatus(), isError: false }
  },
}
