// engine/vsm/fingerprintRepetition.ts
// P4.3 (STATE doc Phase 4(b), VI.3 signal 2): semantic action-fingerprint
// repetition — production consensus from OpenHands StuckDetector and
// terminal-agent two-tier fingerprinting. Hash = the shared
// toolCallFingerprint (name + normalized args) so this, stuck detection,
// and windowed variety never drift.
//
// Alarms (computed on read, MEASUREMENT ONLY — no intervention here; P4.4):
//   'identical'   — 3 consecutive identical fingerprints
//   'alternating' — last 6 calls form A-B-A-B-A-B with A ≠ B
//
// Whitelist: legitimate polling tools (known false-positive class, OpenHands
// #5355). Default: ContractStatus (the model re-polls contract state by
// design). Expand only on observed false positives.

import { toolCallFingerprint } from './windowedVariety.js'

const WINDOW_SIZE = 20
const IDENTICAL_RUN = 3
const ALTERNATING_LEN = 6
const DEFAULT_WHITELIST = ['ContractStatus']

export type FingerprintAlarm = 'identical' | 'alternating' | null

export class FingerprintRepetitionDetector {
  /** Rolling (fingerprint, toolName) pairs, oldest first, capped at WINDOW_SIZE. */
  private recent: { fp: string; name: string }[] = []
  private readonly whitelist: Set<string>

  constructor(whitelist: string[] = DEFAULT_WHITELIST) {
    this.whitelist = new Set(whitelist)
  }

  /** Record one tool call (always-track zone — fed from onToolResult). */
  recordCall(name: string, input?: unknown): void {
    this.recent.push({ fp: toolCallFingerprint(name, input), name })
    if (this.recent.length > WINDOW_SIZE) {
      this.recent = this.recent.slice(-WINDOW_SIZE)
    }
  }

  /** Current alarm state, computed over the window tail. */
  alarm(): FingerprintAlarm {
    // Identical: IDENTICAL_RUN consecutive identical fingerprints at the tail.
    if (this.recent.length >= IDENTICAL_RUN) {
      const tail = this.recent.slice(-IDENTICAL_RUN)
      if (
        tail.every(c => c.fp === tail[0].fp) &&
        !this.whitelist.has(tail[0].name)
      ) {
        return 'identical'
      }
    }
    // Alternating: A-B-A-B-A-B over the last ALTERNATING_LEN calls, A ≠ B.
    if (this.recent.length >= ALTERNATING_LEN) {
      const tail = this.recent.slice(-ALTERNATING_LEN)
      const a = tail[0]
      const b = tail[1]
      if (
        a.fp !== b.fp &&
        tail.every((c, i) => c.fp === (i % 2 === 0 ? a.fp : b.fp)) &&
        !this.whitelist.has(a.name) &&
        !this.whitelist.has(b.name)
      ) {
        return 'alternating'
      }
    }
    return null
  }
}
