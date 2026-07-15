// engine/vsm/turnNovelty.ts
// P4.3 (STATE doc Phase 4(b), VI.3 signal 4): information gain / novelty —
// revisiting explored regions without new insight predicts failure. Per-turn
// fraction of touched file paths never seen before this session.
//
// null semantics: a turn that touched no file paths is null, not zero —
// a pure-reasoning turn is not "zero novelty".
//
// Paths normalized (backslash→slash, lowercase) so Windows separator and
// case variants of the same file don't read as novelty.

export type NoveltySnapshot = {
  /** New-path fraction in [0,1] for the last sealed turn; null when the
   *  turn touched no paths. */
  infoGain: number | null
}

export class TurnNoveltyMeter {
  /** Every path seen this session (normalized). */
  private seen = new Set<string>()
  /** Paths touched since the last turn seal. */
  private turnTouched = new Set<string>()
  private last: NoveltySnapshot = { infoGain: null }

  /** Record one file-path touch (always-track zone — fed from onToolResult). */
  recordPath(path: string): void {
    this.turnTouched.add(path.replace(/\\/g, '/').toLowerCase())
  }

  /** Seal the turn: compute infoGain, absorb the turn's paths into seen. */
  onTurnComplete(): void {
    if (this.turnTouched.size === 0) {
      this.last = { infoGain: null }
      return
    }
    let novel = 0
    for (const p of this.turnTouched) {
      if (!this.seen.has(p)) {
        novel++
        this.seen.add(p)
      }
    }
    this.last = { infoGain: novel / this.turnTouched.size }
    this.turnTouched = new Set()
  }

  /** Last sealed value — what the report/ledger/S5 see for this turn. */
  snapshot(): NoveltySnapshot {
    return { ...this.last }
  }
}
