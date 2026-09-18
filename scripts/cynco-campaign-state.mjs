import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function freshState(id) {
  return { id, calibration: null, waveCount: 0, lastBase: null, lastFails: null, consecutiveNoProgress: 0,
           ideationAuthority: 0, proposals: [], pendingNotifications: [] }
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
      // If the rename fails the corrupt file is still sitting where the next
      // save will overwrite it — the forensics are gone and nothing said so.
      try { renameSync(this.statePath, backup) }
      catch (re) { console.error(`[campaign] could not back up the corrupt state.json to ${backup} (${re.message}) — it will be overwritten by the next save`) }
      console.error(`[campaign] state.json corrupt — backed up to ${backup}, starting fresh: ${e.message}`)
      this.state = freshState(this.state.id)
    }
    return this
  }
  save() {
    mkdirSync(this.dir, { recursive: true })
    this.adoptExternalDecisions()
    const tmp = `${this.statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(tmp, this.statePath)
  }
  /**
   * `--approve-proposal` / `--reject-proposal` run as a SECOND process while the
   * runner holds this object in memory for days. The runner's next save would
   * write its stale `pending` over the operator's decision — so before every
   * write, a decision on disk wins over a pending proposal in memory, and an
   * approval carries its authority with it. Nothing else is merged: the runner
   * is the only writer of every other field.
   */
  adoptExternalDecisions() {
    if (!existsSync(this.statePath)) return
    let disk
    try { disk = JSON.parse(readFileSync(this.statePath, 'utf8')) } catch { return }
    for (const d of disk?.proposals ?? []) {
      if (d.status === 'pending') continue
      const mine = (this.state.proposals ?? []).find(p => p.name === d.name && p.proposedAt === d.proposedAt)
      if (!mine || mine.status !== 'pending') continue
      mine.status = d.status; mine.decidedAt = d.decidedAt ?? null
      if (d.status === 'approved' && typeof disk.ideationAuthority === 'number') {
        this.state.ideationAuthority = Math.max(this.state.ideationAuthority ?? 0, disk.ideationAuthority)
      }
    }
  }
  appendWave(record) { mkdirSync(this.dir, { recursive: true }); appendFileSync(this.wavesPath, JSON.stringify(record) + '\n') }
  /**
   * An appendFileSync that died mid-write leaves a truncated LAST line. Losing
   * the promotion evidence in every earlier wave over it — with a JSON parse
   * error as the only explanation — is the worse failure, so an unparseable
   * line is skipped with a warning and the rest are returned.
   */
  waves() {
    if (!existsSync(this.wavesPath)) return []
    const out = []
    const lines = readFileSync(this.wavesPath, 'utf8').split('\n').filter(Boolean)
    lines.forEach((l, i) => {
      try { out.push(JSON.parse(l)) }
      catch (e) { console.error(`[campaign] waves.jsonl line ${i + 1}${i === lines.length - 1 ? ' (the last line — a write was interrupted)' : ''} is not JSON, skipping it: ${e.message}`) }
    })
    return out
  }
}
