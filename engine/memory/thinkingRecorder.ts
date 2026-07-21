/**
 * Brain Stream persistence (spec D1): full thinking text per turn to
 * ~/.cynco/sessions/<sessionId>.thinking.jsonl, one JSONL record per turn.
 * The mission ledger gets digests only, via aggregateSession().
 * GC: gcOldSessions already sweeps *.jsonl in the sessions dir, which matches
 * *.thinking.jsonl — locked in by a test in gcOldSessions.test.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { EntropyDigest } from './uncertaintyTracker.js'

export type TurnEntropy = { thinking: EntropyDigest | null; output: EntropyDigest | null }

export type TurnThinkingRecord = {
  turn: number
  ts: number
  text: string
  tokenCount: number
  durationMs: number
  entropy: TurnEntropy | null
}

function defaultDir(): string {
  return join(homedir(), '.cynco', 'sessions')
}

function fileFor(sessionId: string, dir?: string): string {
  return join(dir ?? defaultDir(), `${sessionId}.thinking.jsonl`)
}

export class ThinkingRecorder {
  private buffer = ''
  private turn = 0
  private readonly filePath: string

  constructor(sessionId: string, dir?: string) {
    const d = dir ?? defaultDir()
    try { mkdirSync(d, { recursive: true }) } catch (err) {
      console.log(`[thinking] mkdir failed: ${err}`)
    }
    this.filePath = join(d, `${sessionId}.thinking.jsonl`)
  }

  onThinkingDelta(text: string): void {
    this.buffer += text
  }

  /** Drop any buffered thinking without writing a record (aborted/failed model call). */
  discardBuffer(): void {
    this.buffer = ''
  }

  /** Append ONE record for the completed turn; never throws (D: log + keep running). */
  finalizeTurn(info: { tokenCount: number; durationMs: number; entropy: TurnEntropy | null }): void {
    this.turn++
    const hasEntropy = info.entropy && (info.entropy.thinking || info.entropy.output)
    if (this.buffer.length === 0 && !hasEntropy) return
    const rec: TurnThinkingRecord = {
      turn: this.turn,
      ts: Date.now(),
      text: this.buffer,
      tokenCount: info.tokenCount,
      durationMs: info.durationMs,
      entropy: info.entropy,
    }
    this.buffer = ''
    try {
      appendFileSync(this.filePath, JSON.stringify(rec) + '\n')
    } catch (err) {
      console.log(`[thinking] append failed: ${err}`)
    }
  }

  static readTurns(sessionId: string, dir?: string): TurnThinkingRecord[] {
    const path = fileFor(sessionId, dir)
    if (!existsSync(path)) return []
    const out: TurnThinkingRecord[] = []
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line) as TurnThinkingRecord) } catch (err) {
        console.log(`[thinking] skipping corrupt line in ${sessionId}: ${err}`)
      }
    }
    return out
  }

  static readTurn(sessionId: string, turn: number, dir?: string): TurnThinkingRecord | null {
    return ThinkingRecorder.readTurns(sessionId, dir).find(r => r.turn === turn) ?? null
  }

  /** Session-level digest for the mission ledger: mean of means, max of maxes, sum of spikes. */
  static aggregateSession(sessionId: string, dir?: string): TurnEntropy | null {
    const turns = ThinkingRecorder.readTurns(sessionId, dir)
    if (turns.length === 0) return null
    const agg = (kind: 'thinking' | 'output'): EntropyDigest | null => {
      const ds = turns.map(t => t.entropy?.[kind]).filter((d): d is EntropyDigest => !!d)
      if (ds.length === 0) return null
      return {
        mean: ds.reduce((a, d) => a + d.mean, 0) / ds.length,
        max: Math.max(...ds.map(d => d.max)),
        spikeCount: ds.reduce((a, d) => a + d.spikeCount, 0),
      }
    }
    return { thinking: agg('thinking'), output: agg('output') }
  }
}
