// engine/daemon/missionLedger.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join } from 'path'
import type {
  MissionConfig, MissionState, Recommendation, RunRecord,
} from './types.js'

export interface ApprovalResolution {
  rec: Recommendation
  verdict: 'approve' | 'reject'
  promotionEligible: boolean
}

export class MissionLedger {
  readonly dir: string
  readonly config: MissionConfig
  state: MissionState

  private constructor(dir: string, config: MissionConfig, state: MissionState) {
    this.dir = dir
    this.config = config
    this.state = state
  }

  static load(dir: string): MissionLedger {
    const config = JSON.parse(readFileSync(join(dir, 'mission.json'), 'utf-8')) as MissionConfig
    const statePath = join(dir, 'state.json')
    let state: MissionState = { lastSeen: {}, nextFire: {}, pending: {}, trust: {}, failureStreak: 0 }
    if (existsSync(statePath)) {
      try {
        state = JSON.parse(readFileSync(statePath, 'utf-8')) as MissionState
      } catch (err) {
        // A truncated state.json (power loss mid-write) must not crash-loop the
        // daemon forever. Preserve the corrupt file for forensics, start fresh.
        const backup = `${statePath}.corrupt`
        try { renameSync(statePath, backup) } catch {}
        console.error(`[ledger:${config.id}] state.json corrupt — backed up to ${backup}, starting with fresh state: ${err instanceof Error ? err.message : err}`)
      }
    }
    // Ensure every trustLadder action type has a state entry
    for (const [actionType, ladder] of Object.entries(config.trustLadder)) {
      if (!state.trust[actionType]) {
        state.trust[actionType] = { mode: ladder.mode, approvedStreak: 0 }
      }
    }
    return new MissionLedger(dir, config, state)
  }

  saveState(): void {
    mkdirSync(this.dir, { recursive: true })
    // Atomic write: a crash mid-write must never leave a truncated state.json.
    const statePath = join(this.dir, 'state.json')
    const tmpPath = `${statePath}.tmp`
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8')
    renameSync(tmpPath, statePath)
  }

  recordRun(run: RunRecord): void {
    appendFileSync(join(this.dir, 'runs.jsonl'), JSON.stringify(run) + '\n', 'utf-8')
  }

  recentRuns(n: number): RunRecord[] {
    const p = join(this.dir, 'runs.jsonl')
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim())
    // Tolerate truncated appends (crash mid-write) — one bad line must not
    // permanently break every future fire() on this mission.
    const runs: RunRecord[] = []
    for (const l of lines) {
      try { runs.push(JSON.parse(l) as RunRecord) } catch {}
    }
    return runs.slice(-n)
  }

  setNextFire(triggerId: string, iso: string): void {
    this.state.nextFire[triggerId] = iso
  }

  setLastSeen(leagueId: string, hash: string): void {
    this.state.lastSeen[leagueId] = hash
  }

  addPending(rec: Recommendation): void {
    this.state.pending[rec.id] = { rec, createdAt: new Date().toISOString() }
  }

  resolveApproval(recId: string, verdict: 'approve' | 'reject'): ApprovalResolution | null {
    // recId arrives from the phone over ntfy — hasOwn guards against prototype
    // keys like "constructor" reaching the plain-object pending map.
    if (!Object.hasOwn(this.state.pending, recId)) return null
    const pending = this.state.pending[recId]
    if (!pending) return null
    delete this.state.pending[recId]

    const ladder = this.config.trustLadder[pending.rec.actionType]
    const trust = this.state.trust[pending.rec.actionType]
    let promotionEligible = false
    if (ladder && trust) {
      if (verdict === 'approve') {
        trust.approvedStreak += 1
        promotionEligible = trust.mode === 'ask' && trust.approvedStreak >= ladder.promoteAt
      } else {
        trust.approvedStreak = 0
      }
    }
    this.saveState()
    return { rec: pending.rec, verdict, promotionEligible }
  }
}
