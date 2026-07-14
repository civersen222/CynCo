// engine/vsm/windowedVariety.ts
// P1.5: rolling-window distinguishable-state counter — the windowed
// counterpart to the monotone VarietyEngine ratio. Ashby's variety is the
// number of CURRENT distinguishable states; the monotone measure can only
// grow with cumulative activity ("overload" ≈ turn > 8 — STATE doc §3.1),
// so it cannot discriminate. Both series are logged to the ledger so
// Phase 3 can compare their discrimination power head-to-head.
//
// Deliberately NOT in cybernetics-core (vendored library — do not modify).
//
// A "state" is a (toolName, normalized-args) fingerprint — the same format
// stuck detection uses (cyberneticsGovernance.ts lastToolCallSigs; name-only
// signatures caused a false HALT on 2026-06-12).

const FINGERPRINT_ARG_CAP = 200

export class WindowedVarietyMeter {
  /** Sealed per-turn fingerprint sets, oldest first, capped at windowTurns. */
  private window: Set<string>[] = []
  /** Fingerprints recorded since the last turn seal. */
  private current = new Set<string>()

  constructor(private readonly windowTurns: number = 10) {}

  /** Record one tool call. Mirrors the stuck-detection signature format. */
  recordCall(name: string, input?: unknown): void {
    this.current.add(`${name}:${JSON.stringify(input ?? {}).slice(0, FINGERPRINT_ARG_CAP)}`)
  }

  /** Seal the in-progress turn into the rolling window. */
  onTurnComplete(): void {
    this.window.push(this.current)
    this.current = new Set()
    if (this.window.length > this.windowTurns) {
      this.window = this.window.slice(-this.windowTurns)
    }
  }

  /** Distinct states across the last windowTurns sealed turns PLUS the
   *  in-progress turn (the loop seals at message_stop before the batch's
   *  tools execute, so post-batch reports must see current calls). */
  count(): number {
    const union = new Set<string>(this.current)
    for (const turn of this.window) {
      for (const fp of turn) union.add(fp)
    }
    return union.size
  }
}
