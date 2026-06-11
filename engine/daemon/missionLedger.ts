// engine/daemon/missionLedger.ts
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs'
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
    let state: MissionState
    if (existsSync(statePath)) {
      state = JSON.parse(readFileSync(statePath, 'utf-8')) as MissionState
    } else {
      state = { lastSeen: {}, nextFire: {}, pending: {}, trust: {}, failureStreak: 0 }
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
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2), 'utf-8')
  }

  recordRun(run: RunRecord): void {
    appendFileSync(join(this.dir, 'runs.jsonl'), JSON.stringify(run) + '\n', 'utf-8')
  }

  recentRuns(n: number): RunRecord[] {
    const p = join(this.dir, 'runs.jsonl')
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf-8').split('\n').filter(l => l.trim())
    return lines.slice(-n).map(l => JSON.parse(l) as RunRecord)
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
