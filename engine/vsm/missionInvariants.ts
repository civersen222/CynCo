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
import { importRetainedFrom, type RetainedStoreLike } from './retainedConfigStore.js'

/** This instance's id in the retained-configuration store. */
export const MISSION_INVARIANTS_INSTANCE = 'mission-invariants'

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
/**
 * What reaches the wire on every `governance.status` frame. The two arrays are
 * WINDOWS, not the history: a long mission accumulates thousands of calls and
 * this object is re-emitted per model iteration, so an uncapped `denials` would
 * put the whole run's denial log on the socket once per turn. The counts and
 * the aggregates carry the full-run facts the windows drop — same shape the
 * `ultrastable` frame next to it already uses (`trace` capped, `traceLength`
 * beside it).
 */
export interface InvariantSnapshot {
  caps: InvariantCaps; configuration: 'full' | 'edit-only'
  callsSinceSourceEdit: number; callsSinceCommit: number
  /** Last 20 uniselector steps. `stepCount` is how many there have been. */
  steps: InvariantStep[]; stepCount: number
  /** Last 50 denials. `denialCount` is how many there have been. */
  denials: InvariantDenial[]; denialCount: number
  /** Over ALL denials, not the window. */
  denialsByInvariant: Record<InvariantKind, number>
  /** Over ALL denials, not the window. A denial whose next call has not been
   *  observed yet is counted under `pending`, so these always sum to
   *  `denialCount`. */
  nextCallClassCounts: Record<string, number>
  /** `nextCallClassCounts` split by the invariant that denied. Over ALL denials,
   *  like `denialsByInvariant`, whose per-kind totals these sum to. The window
   *  (`denials`) drops after 50; the falsification programme's per-invariant
   *  "did the denial change the next call" needs the whole run. */
  nextCallClassByInvariant: Record<InvariantKind, Record<string, number>>
  /** Variables this run has stopped denying on — see TERMINAL_RELENT_AFTER. */
  terminalRelents: InvariantKind[]
  revertRefusals: number; codeIndexAssisted: number
}

const EDITOR_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'ApplyPatch', 'ReplaceFunction', 'NotebookEdit'])
const INSPECT_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Ls'])
const RELENT_AFTER = 3
// Full relent cycles (RELENT_AFTER denials each) on the SAME variable before
// the gate gives that variable up for the rest of the run — the read-loop
// gate's own design, one level slower. See `terminal` below.
const TERMINAL_RELENT_AFTER = 3
const DWELL = 3
// Window sizes for the per-turn status frame (see InvariantSnapshot).
const DENIAL_WINDOW = 50
const STEP_WINDOW = 20

/**
 * One classifier for "what did this call do", shared by the invariants
 * (edit-gap / commit-gap accounting) and the live POSIWID reading in
 * conversationLoop. Classes: `sourceEdit`, `inspect`, `codeIndex`, the Bash
 * effects (`read` `write` `run` `commit` `revert` `other`), `denied-or-error`,
 * and `other` for every remaining tool.
 */
export function classifyCall(toolName: string, input: any, isError: boolean): string {
  if (isError) return 'denied-or-error'
  if (EDITOR_TOOLS.has(toolName)) return 'sourceEdit'
  if (toolName === 'Bash' && typeof input?.command === 'string' && isSourceRewrite(input.command)) return 'sourceEdit'
  if (toolName === 'Bash') return bashEffect(String(input?.command ?? ''))
  if (INSPECT_TOOLS.has(toolName)) return 'inspect'
  if (toolName === 'CodeIndex') return 'codeIndex'
  return 'other'
}

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
  // Completed relent cycles per variable, and the variables the gate has given
  // up on. The commit gap is the one that can be genuinely unsatisfiable —
  // nothing staged, a failing pre-commit hook, a cwd that is not a repo — and
  // an unsatisfiable cap does not regulate, it just holds the run at the
  // relent rate (one inspection in four) for hours. The read-loop gate makes
  // the same concession one level faster and for the same reason: a gate that
  // never yields converts "you should be committing by now" into "you may
  // never look at anything again".
  private readonly relentCycles = new Map<InvariantKind, number>()
  private readonly terminal = new Set<InvariantKind>()
  private readonly denials: InvariantDenial[] = []
  private readonly stepCallIndex: number[] = []
  private revertRefusals = 0
  private codeIndexAssisted = 0

  /**
   * `retainedStore`: when given, the homeostat is seeded from the
   * `mission-invariants` table it holds (vsm/retainedConfigStore.ts) — the
   * configurations earlier missions found restored viability. Memory only: the
   * gate keys on the caps (see the header), the search stays `Ordered`, and no
   * retained position is applied.
   */
  constructor(readonly caps: InvariantCaps, opts: { retainedStore?: RetainedStoreLike } = {}) {
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
    if (opts.retainedStore) importRetainedFrom(this.homeostat, opts.retainedStore, MISSION_INVARIANTS_INSTANCE)
  }

  /** Write the homeostat's retained table to `store` (mission end). Throws on a store failure — the caller logs. */
  saveRetained(store: RetainedStoreLike, sessionId: string | null): { version: number; changed: boolean } {
    return store.save(MISSION_INVARIANTS_INSTANCE, this.homeostat.exportRetained(), sessionId)
  }

  /** The homeostat's live retained table, parsed. */
  retainedTable(): Record<string, unknown> {
    return JSON.parse(this.homeostat.exportRetained())
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

  /**
   * `escalated` is the terminal relent's single announcement: the gate has
   * denied this variable for three full relent cycles and is now standing
   * down on it. Say so plainly — an order that has stopped being enforced but
   * is still being repeated teaches the model that the teachbacks are noise.
   */
  private teachback(invariant: 'edit-gap' | 'commit-gap', escalated = false): string {
    const hot = [...this.readCounts.entries()].filter(([, n]) => n >= 3).map(([p, n]) => `${p} ${n}×`).slice(0, 3)
    const last = this.lastEdit
      ? `which was ${this.lastEdit.tool} on ${this.lastEdit.path}`
      : 'and no source edit yet in this run'
    const since = hot.length ? ` You have read ${hot.join(', ')} since.` : ''
    if (invariant === 'edit-gap') {
      const tail = escalated
        ? `This is the third time this run you have been denied through a full relent cycle on this cap. ` +
          `If there is genuinely nothing to edit, say so in your reply and continue; inspection is no longer withheld for this cap.`
        : `Make the smallest edit that tests your current hypothesis, or commit what you have. Reading resumes after that edit.`
      return `[invariant] DENIED (edit-gap): ${this.callsSinceSourceEdit} calls since your last source edit, ${last}.${since} ${tail}`
    }
    const tail = escalated
      ? `This is the third time this run you have been denied through a full relent cycle on this cap. ` +
        `If there is genuinely nothing to commit, say so in your reply and continue; inspection is no longer withheld for this cap.`
      : `Stage the files you changed by name and commit now — a commit is the only backup this run has. Reading resumes after the commit.`
    return `[invariant] DENIED (commit-gap): ${this.callsSinceCommit} calls since your last commit.${since} ${tail}`
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
      const which = this.callsSinceSourceEdit > this.caps.editGapCap ? 'edit-gap' : 'commit-gap'
      // Given up on this variable. The essential variable and the homeostat go
      // on observing it — the step trace is the governance data and must not
      // acquire a blind spot — the gate just stops withholding inspection for
      // it. The other variable is unaffected: the run that cannot commit can
      // still be held to making edits.
      if (this.terminal.has(which)) return { kind: 'allow' }
      if (this.relentArmed) { this.relentArmed = false; this.consecutiveDenies = 0; return { kind: 'allow' } }
      this.consecutiveDenies++
      let escalated = false
      if (this.consecutiveDenies >= RELENT_AFTER) {
        this.relentArmed = true
        const cycles = (this.relentCycles.get(which) ?? 0) + 1
        this.relentCycles.set(which, cycles)
        if (cycles >= TERMINAL_RELENT_AFTER) {
          this.terminal.add(which)
          escalated = true
          // Hand the other variable a clean slate rather than a half-armed
          // relent inherited from the one just given up on.
          this.relentArmed = false
          this.consecutiveDenies = 0
        }
      }
      return this.deny(which, toolName, this.teachback(which, escalated))
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
    return classifyCall(toolName, input, isError)
  }

  snapshot(): InvariantSnapshot {
    const steps = this.homeostat.trace().map((e, i) => ({
      callIndex: this.stepCallIndex[i] ?? -1,
      variable: e.violations.join('+'),
      from: 'Discrete' in e.from ? e.from.Discrete : 'continuous',
      to: 'Discrete' in e.to ? e.to.Discrete : 'continuous',
      restoredAfter: e.restoredAfter,
    }))
    const denialsByInvariant: Record<InvariantKind, number> = { 'edit-gap': 0, 'commit-gap': 0, revert: 0 }
    const nextCallClassCounts: Record<string, number> = {}
    const nextCallClassByInvariant: Record<InvariantKind, Record<string, number>> = { 'edit-gap': {}, 'commit-gap': {}, revert: {} }
    for (const d of this.denials) {
      denialsByInvariant[d.invariant] = (denialsByInvariant[d.invariant] ?? 0) + 1
      const k = d.nextCallClass ?? 'pending'
      nextCallClassCounts[k] = (nextCallClassCounts[k] ?? 0) + 1
      const per = nextCallClassByInvariant[d.invariant]
      per[k] = (per[k] ?? 0) + 1
    }
    return {
      caps: this.caps, configuration: this.isEditOnly() ? 'edit-only' : 'full',
      callsSinceSourceEdit: this.callsSinceSourceEdit, callsSinceCommit: this.callsSinceCommit,
      steps: steps.slice(-STEP_WINDOW), stepCount: steps.length,
      denials: this.denials.slice(-DENIAL_WINDOW), denialCount: this.denials.length,
      denialsByInvariant, nextCallClassCounts, nextCallClassByInvariant, terminalRelents: [...this.terminal],
      revertRefusals: this.revertRefusals, codeIndexAssisted: this.codeIndexAssisted,
    }
  }
}
