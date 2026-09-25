/**
 * Per-rule earned S5 authority (Phase 4).
 *
 * `LOCALCODE_S5_ENFORCE` is all-or-nothing: every rule may act, or none may.
 * Whether a rule has EARNED the right to act is a question the outcome ledger
 * can answer — does it fire more often on missions that failed? — and the
 * campaign runner writes that answer, per rule, to
 * `~/.cynco/datasets/rule-verdicts.json` at every wave verdict
 * (`scripts/cynco-rule-verdicts.mjs`, verdict strings from `ruleVerdictOf` in
 * `scripts/cynco-signal-validation.mjs`).
 *
 * This reads that file once per session and answers, per decision:
 *   - `earned`   — every rule behind the decision reads exactly 'PREDICTIVE';
 *   - `advisory` — at least one does not, or no rule is behind it at all
 *                  (nothing earned it). Never applied, whatever the env says;
 *   - `legacy`   — there is no (readable) verdict file, so nothing has been
 *                  measured and the decision is governed by
 *                  `LOCALCODE_S5_ENFORCE` exactly as before Phase 4.
 *
 * Earned authority never overrides the global cap: `isEnforced(false, 'earned')`
 * is false. The cap is the operator's; the verdict can only withhold more.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type Authority = 'earned' | 'advisory' | 'legacy'

const SCHEMA = 1

/** Where the campaign runner writes the verdicts — `RULE_VERDICTS_PATH` in
 *  scripts/cynco-rule-verdicts.mjs, the same join (pinned by ruleAuthority.test.ts). */
export function ruleVerdictsPath(home: string): string {
  return join(home, 'datasets', 'rule-verdicts.json')
}

/** Whether a decision is applied: the global switch AND the rule's authority. */
export function isEnforced(s5Enforce: boolean, authority: Authority): boolean {
  return s5Enforce && authority !== 'advisory'
}

/** The auto-apply timer on a warning-tier `governance.recommendation`:
 *  none for a revert (always a human's call) and none for an `advisory`
 *  decision (its rules have not earned the right to act, so it must not act
 *  on a timer either); 60 s otherwise, as before Phase 4. */
export function recommendationAutoApplyMs(authority: Authority, revert: boolean | undefined): number | undefined {
  if (revert || authority === 'advisory') return undefined
  return 60000
}

export class RuleAuthority {
  readonly mode: 'earned' | 'legacy'
  private readonly verdicts: ReadonlyMap<string, string>
  private readonly path: string | null
  private readonly why: 'missing' | 'unreadable' | null

  private constructor(mode: 'earned' | 'legacy', verdicts: Map<string, string>, path: string | null, why: 'missing' | 'unreadable' | null) {
    this.mode = mode
    this.verdicts = verdicts
    this.path = path
    this.why = why
  }

  /** The legacy reading, without touching disk. */
  static legacy(): RuleAuthority {
    return new RuleAuthority('legacy', new Map(), null, 'missing')
  }

  /**
   * Read the verdict file. Missing → legacy, quietly (the normal state until a
   * campaign verdict has written one). Present but unparseable or not the
   * schema → legacy WITH a warning, because every verdict it held is ignored.
   */
  static load(path: string): RuleAuthority {
    if (!existsSync(path)) return new RuleAuthority('legacy', new Map(), path, 'missing')
    let raw: any
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'))
    } catch (e) {
      console.warn(`[s5] ${path} is not readable JSON — S5 authority falls back to legacy: ${e instanceof Error ? e.message : String(e)}`)
      return new RuleAuthority('legacy', new Map(), path, 'unreadable')
    }
    const rules = raw?.rules
    if (!raw || raw.schema !== SCHEMA || !rules || typeof rules !== 'object' || Array.isArray(rules)) {
      console.warn(`[s5] ${path} is not a schema-${SCHEMA} rule-verdict file — S5 authority falls back to legacy`)
      return new RuleAuthority('legacy', new Map(), path, 'unreadable')
    }
    const verdicts = new Map<string, string>()
    for (const [id, r] of Object.entries(rules as Record<string, { verdict?: unknown }>)) {
      if (typeof r?.verdict === 'string') verdicts.set(id, r.verdict)
    }
    return new RuleAuthority('earned', verdicts, path, null)
  }

  authorityOf(ruleIds: string[]): Authority {
    if (this.mode === 'legacy') return 'legacy'
    if (ruleIds.length === 0) return 'advisory'
    return ruleIds.every(id => this.verdicts.get(id) === 'PREDICTIVE') ? 'earned' : 'advisory'
  }

  /** The stored verdict string for one rule; null when the file never saw it fire. */
  verdictOf(ruleId: string): string | null {
    return this.verdicts.get(ruleId) ?? null
  }

  predictiveCount(): number {
    let n = 0
    for (const v of this.verdicts.values()) if (v === 'PREDICTIVE') n++
    return n
  }

  total(): number {
    return this.verdicts.size
  }

  /** The one line the loop logs at session start. */
  logLine(): string {
    if (this.mode === 'earned') return `[s5] rule authority: earned (${this.predictiveCount()} predictive of ${this.total()})`
    if (this.why === 'unreadable') return `[s5] rule authority: legacy (unreadable verdict file at ${this.path})`
    return this.path ? `[s5] rule authority: legacy (no verdict file at ${this.path})` : '[s5] rule authority: legacy (no verdict file)'
  }
}
