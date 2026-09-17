/**
 * Mission invariants — the campaign level's S3 terms handed down to the wave (S1).
 *
 * Every order here used to be a sentence in the brief: "40 tool calls without an
 * Edit = STOP", "you may not revert a file, ever". C8 wave 1 went 193 calls
 * without a source edit, read around the read-loop gate through Bash, and spent
 * its last tool call on `git checkout --`. A sentence has no regulatory variety
 * against a command; a refusal has exactly the command's variety (Ashby).
 *
 * The pacing quantities are ESSENTIAL VARIABLES of an ultrastable system whose
 * step function is the offered tool set (Ashby's uniselector: full → edit-only).
 * The slow loop waits `dwell` calls after a step before judging it, and retains
 * the configuration that restored viability. Every denial is a teachback
 * (Pask): it states what the regulator observed and names the smallest next act.
 * Every denial is logged with what the next call did — the outcome the
 * falsification programme needs.
 *
 * Gating decision, corrected from the original design: the uniselector's OWN
 * position cannot be trusted to hold a restriction. With a 2-position Discrete
 * step function and `Ordered` search, a persistent violation cycles
 * full → edit-only → full every `dwell + 1` observations (each further violated
 * observation after dwell expires steps again, and the position wraps). A gate
 * keyed on `homeostat.configuration()` would therefore re-open inspection while
 * the essential variable is still over cap. `evaluate()` below denies directly
 * off `callsSinceSourceEdit`/`callsSinceCommit` vs. the caps; the homeostat is
 * still built and observed on every call, and its trace is exactly the
 * governance data (`snapshot().steps`, with `restoredAfter`) the falsification
 * programme reads — it is just not the gate's own truth about "am I denying".
 */
import { foundations } from '../cybernetics-core/src/index.js'
import { bashEffect } from '../tools/bashEffect.js'
import { isSourceRewrite } from '../tools/toolHints.js'

export interface InvariantCaps { editGapCap: number; commitGapCap: number; revertBan: boolean; codeIndexFirst: boolean }

export function parseInvariantCaps(raw: unknown): InvariantCaps | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
  const editGapCap = num(r.editGapCap); const commitGapCap = num(r.commitGapCap)
  if (editGapCap === null || commitGapCap === null) return null
  if (typeof r.revertBan !== 'boolean' || typeof r.codeIndexFirst !== 'boolean') return null
  return { editGapCap, commitGapCap, revertBan: r.revertBan, codeIndexFirst: r.codeIndexFirst }
}

export type InvariantKind = 'edit-gap' | 'commit-gap' | 'revert'
export type InvariantVerdict = { kind: 'allow' } | { kind: 'deny'; invariant: InvariantKind; message: string }
export interface InvariantDenial { callIndex: number; invariant: InvariantKind; tool: string; nextCallClass: string | null }
export interface InvariantStep { callIndex: number; variable: string; from: string; to: string; restoredAfter: number | null }
export interface InvariantSnapshot {
  caps: InvariantCaps; configuration: 'full' | 'edit-only'
  callsSinceSourceEdit: number; callsSinceCommit: number
  steps: InvariantStep[]; denials: InvariantDenial[]; revertRefusals: number; codeIndexAssisted: number
}

const EDITOR_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit'])
const INSPECT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Ls'])
const RELENT_AFTER = 3
const DWELL = 3

const REVERT_MESSAGE =
  '[invariant] REFUSED: that command discards work. You may not revert a file in this run, ' +
  'for any reason — not git checkout --, git restore, git stash, git reset --hard, or git clean. ' +
  'Permitted: a targeted Edit on top of the last commit, saying in the commit message what came ' +
  'out and why. Salvage belongs under C:\\tmp, never in a stash.'

export class MissionInvariants {
  private readonly homeostat: InstanceType<typeof foundations.UltrastableSystem>
  private callIndex = 0
  private callsSinceSourceEdit = 0
  private callsSinceCommit = 0
  private lastEdit: { tool: string; path: string; callIndex: number } | null = null
  private readCounts = new Map<string, number>()
  private consecutiveDenies = 0
  private relentArmed = false
  private readonly denials: InvariantDenial[] = []
  private readonly stepCallIndex: number[] = []
  private revertRefusals = 0
  private codeIndexAssisted = 0

  constructor(readonly caps: InvariantCaps) {
    // No-op sink: withConfig requires a FeedbackLoop and feeds measurements[0]
    // into it on every observe(), but this homeostat's regulation happens via
    // the essential-variable bounds/uniselector below, not the fast loop's
    // error signal. Gain 0 means update() always returns 0 and influences
    // nothing; the loop exists only to satisfy the constructor.
    const fast = new foundations.FeedbackLoop('delivery_fast', foundations.FeedbackTypes.Negative, 0, 0)
    this.homeostat = foundations.UltrastableSystem.withConfig(
      fast,
      [
        { name: 'callsSinceSourceEdit', bounds: [0, caps.editGapCap], hysteresis: 0 },
        { name: 'callsSinceCommit', bounds: [0, caps.commitGapCap], hysteresis: 0 },
      ],
      { kind: 'Discrete', positions: ['full', 'edit-only'], index: 0 },
      { dwell: DWELL, strategy: 'Ordered', seed: 0n },
    )
  }

  /**
   * Denial-driving truth: the essential variables against their caps, not the
   * homeostat's uniselector position (see the header note on cycling). This is
   * also what `snapshot().configuration` reports.
   */
  private isEditOnly(): boolean {
    return this.callsSinceSourceEdit > this.caps.editGapCap || this.callsSinceCommit > this.caps.commitGapCap
  }

  private isInspect(toolName: string, input: any): boolean {
    if (INSPECT_TOOLS.has(toolName)) return true
    return toolName === 'Bash' && bashEffect(String(input?.command ?? '')) === 'read'
  }

  private isRevertCall(toolName: string, input: any): boolean {
    if (toolName === 'Bash') return bashEffect(String(input?.command ?? '')) === 'revert'
    if (toolName === 'Git') return bashEffect(`git ${input?.subcommand ?? ''} ${input?.args ?? ''}`) === 'revert'
    return false
  }

  private teachback(invariant: 'edit-gap' | 'commit-gap'): string {
    const hot = [...this.readCounts.entries()].filter(([, n]) => n >= 3).map(([p, n]) => `${p} ${n}×`).slice(0, 3)
    const last = this.lastEdit
      ? `which was ${this.lastEdit.tool} on ${this.lastEdit.path}`
      : 'and no source edit yet in this run'
    const since = hot.length ? ` You have read ${hot.join(', ')} since.` : ''
    if (invariant === 'edit-gap') {
      return `[invariant] DENIED (edit gap): ${this.callsSinceSourceEdit} calls since your last source edit, ${last}.${since} ` +
        `Make the smallest edit that tests your current hypothesis, or commit what you have. Reading resumes after that edit.`
    }
    return `[invariant] DENIED (commit gap): ${this.callsSinceCommit} calls since your last commit.${since} ` +
      `Stage the files you changed by name and commit now — a commit is the only backup this run has. Reading resumes after the commit.`
  }

  private deny(invariant: InvariantKind, toolName: string, message: string): InvariantVerdict {
    this.denials.push({ callIndex: this.callIndex + 1, invariant, tool: toolName, nextCallClass: null })
    return { kind: 'deny', invariant, message }
  }

  evaluate(toolName: string, input: any): InvariantVerdict {
    if (this.caps.revertBan && this.isRevertCall(toolName, input)) {
      this.revertRefusals++
      return this.deny('revert', toolName, REVERT_MESSAGE)
    }
    if (this.isEditOnly() && this.isInspect(toolName, input)) {
      if (this.relentArmed) { this.relentArmed = false; this.consecutiveDenies = 0; return { kind: 'allow' } }
      this.consecutiveDenies++
      if (this.consecutiveDenies >= RELENT_AFTER) this.relentArmed = true
      const which = this.callsSinceSourceEdit > this.caps.editGapCap ? 'edit-gap' : 'commit-gap'
      return this.deny(which, toolName, this.teachback(which))
    }
    return { kind: 'allow' }
  }

  observeCall(toolName: string, input: any, isError: boolean): void {
    this.callIndex++
    const cls = this.classify(toolName, input, isError)
    // At most one denial is ever open under normal evaluate() -> observeCall()
    // pairing: a deny opens one, and the very next observeCall (the attempted
    // call being recorded) closes it. .find() picks the oldest open denial so
    // that if a caller ever left more than one open, the earliest still gets
    // attributed first rather than the newest silently winning.
    const open = this.denials.find(d => d.nextCallClass === null && d.callIndex < this.callIndex)
    if (open) open.nextCallClass = cls
    if (cls === 'sourceEdit') {
      this.callsSinceSourceEdit = 0
      this.lastEdit = { tool: toolName, path: String(input?.file_path ?? input?.path ?? input?.command ?? '').slice(0, 120), callIndex: this.callIndex }
      this.readCounts.clear()
      this.consecutiveDenies = 0; this.relentArmed = false
    } else {
      this.callsSinceSourceEdit++
      if (this.isInspect(toolName, input)) {
        const key = String(input?.file_path ?? input?.pattern ?? input?.path ?? input?.command ?? '').slice(0, 80)
        this.readCounts.set(key, (this.readCounts.get(key) ?? 0) + 1)
      }
    }
    this.callsSinceCommit++
    this.observeHomeostat(this.callIndex)
  }

  /**
   * A commit is observed out of band — it has no call index of its own. If it
   * lands on a re-step boundary (the essential variable is still over cap and
   * a prior step's dwell has just run out), the homeostat steps here rather
   * than inside `observeCall`. Attribute that step to the last accounted call
   * (`this.callIndex`, left unchanged by this method): it is the most honest
   * index available for a step nothing in the call sequence itself triggered.
   */
  observeCommit(): void {
    this.callsSinceCommit = 0
    this.observeHomeostat(this.callIndex)
  }

  /**
   * Runs one homeostat observation and keeps `stepCallIndex` in lockstep with
   * `homeostat.trace()`. Both `observeCall` and `observeCommit` can trigger a
   * step (the vendored `observe()` steps on ANY sustained violation once dwell
   * is exhausted, regardless of what caused this particular observation), so
   * both must route through here — a step taken only inside `observeCommit`
   * used to grow `trace()` without growing `stepCallIndex`, desyncing the two
   * arrays `snapshot()` zips together positionally.
   */
  private observeHomeostat(callIndexForNewStep: number): void {
    const before = this.homeostat.trace().length
    this.homeostat.observe([this.callsSinceSourceEdit, this.callsSinceCommit])
    if (this.homeostat.trace().length > before) this.stepCallIndex.push(callIndexForNewStep)
  }

  noteCodeIndexAssisted(): void { this.codeIndexAssisted++ }

  private classify(toolName: string, input: any, isError: boolean): string {
    if (isError) return 'denied-or-error'
    if (EDITOR_TOOLS.has(toolName)) return 'sourceEdit'
    if (toolName === 'Bash' && typeof input?.command === 'string' && isSourceRewrite(input.command)) return 'sourceEdit'
    if (toolName === 'Bash') return bashEffect(String(input.command ?? ''))
    if (INSPECT_TOOLS.has(toolName)) return 'inspect'
    if (toolName === 'CodeIndex') return 'codeIndex'
    return 'other'
  }

  snapshot(): InvariantSnapshot {
    const steps = this.homeostat.trace().map((e, i) => ({
      callIndex: this.stepCallIndex[i] ?? -1,
      variable: e.violations.join('+'),
      from: 'Discrete' in e.from ? e.from.Discrete : 'continuous',
      to: 'Discrete' in e.to ? e.to.Discrete : 'continuous',
      restoredAfter: e.restoredAfter,
    }))
    return {
      caps: this.caps, configuration: this.isEditOnly() ? 'edit-only' : 'full',
      callsSinceSourceEdit: this.callsSinceSourceEdit, callsSinceCommit: this.callsSinceCommit,
      steps, denials: [...this.denials], revertRefusals: this.revertRefusals, codeIndexAssisted: this.codeIndexAssisted,
    }
  }
}
