import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function freshState(id) {
  return { id, calibration: null, waveCount: 0, lastBase: null, lastFails: null, consecutiveNoProgress: 0,
           ideationAuthority: 0, proposals: [], pendingNotifications: [], branch: null }
}

// The daemon's missionLedger pattern (engine/daemon/missionLedger.ts:27-56):
// persist before acting, write tmp + rename, keep a corrupt file for forensics.
export class CampaignState {
  constructor(dir) { this.dir = dir; this.state = freshState(dir.split(/[\\/]/).pop()) }
  get statePath() { return join(this.dir, 'state.json') }
  get wavesPath() { return join(this.dir, 'waves.jsonl') }
  load() {
    mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.statePath)) return this
    try { this.state = { ...freshState(this.state.id), ...JSON.parse(readFileSync(this.statePath, 'utf8')) } }
    catch (e) {
      const backup = `${this.statePath}.corrupt`
      try { renameSync(this.statePath, backup) } catch {}
      console.error(`[campaign] state.json corrupt — backed up to ${backup}, starting fresh: ${e.message}`)
      this.state = freshState(this.state.id)
    }
    return this
  }
  save() {
    mkdirSync(this.dir, { recursive: true })
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.statePath)
  }
  appendWave(record) { mkdirSync(this.dir, { recursive: true }); appendFileSync(this.wavesPath, JSON.stringify(record) + '\n') }
  waves() { return existsSync(this.wavesPath) ? readFileSync(this.wavesPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] }
}
