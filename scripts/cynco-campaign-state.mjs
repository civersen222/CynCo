import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

export function freshState(id) {
  return { id, calibration: null, waveCount: 0, lastBase: null, lastFails: null, consecutiveNoProgress: 0,
           ideationAuthority: 0, proposals: [], invariantOverrides: {}, pendingNotifications: [],
           governancePosiwid: { windows: [] }, lastVerdictAt: null,
           // Phase 3, the gate-author seat: the second occupant's earned
           // authority, one record per authoring run, and the reseal history
           // that makes a sealed line's "held" claim falsifiable.
           gateAuthorAuthority: 0, authoring: {}, reseals: [] }
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
   * approval carries its authority with it. Two other fields are merged the
   * same way: `ideationAuthority` and `invariantOverrides` (per-key, the max of
   * the in-memory and disk values — both only ever rise, so the higher one is
   * always the more-approved one). Nothing else is merged: the runner is the
   * only writer of every other field.
   */
  adoptExternalDecisions() {
    if (!existsSync(this.statePath)) return
    let disk
    // M9: this is the ONLY place an operator's `--approve-proposal` reaches the
    // running runner. A corrupt state.json here means the approval is silently
    // dropped and the runner writes its stale `pending` back over it — so the
    // reason has to be on the record even though the save must still proceed.
    try { disk = JSON.parse(readFileSync(this.statePath, 'utf8')) }
    catch (e) { console.error(`[campaign] state.json on disk is unreadable during save — external decisions not merged: ${e.message}`); return }
    for (const d of disk?.proposals ?? []) {
      if (d.status === 'pending') continue
      const mine = (this.state.proposals ?? []).find(p => p.name === d.name && p.proposedAt === d.proposedAt)
      if (!mine || mine.status !== 'pending') continue
      mine.status = d.status; mine.decidedAt = d.decidedAt ?? null
      if (d.status === 'approved' && typeof disk.ideationAuthority === 'number') {
        this.state.ideationAuthority = Math.max(this.state.ideationAuthority ?? 0, disk.ideationAuthority)
      }
      // The gate-author seat's authority rises exactly like ideation's, and by
      // exactly the same route: a `gate-author/gate` approval decided by a
      // SECOND process while this one holds the object in memory.
      if (d.status === 'approved' && typeof disk.gateAuthorAuthority === 'number') {
        this.state.gateAuthorAuthority = Math.max(this.state.gateAuthorAuthority ?? 0, disk.gateAuthorAuthority)
      }
      if (d.status === 'approved' && d.name.startsWith('invariants/') && disk.invariantOverrides) {
        // A blind spread would let a stale disk value clobber a higher one the
        // runner already holds in memory. Caps only ever rise (capProposal /
        // applyProposalDecision), so the merge is monotonic per key: the max
        // wins. 0 is a safe floor — an override is always >= the spec value,
        // and this class does not know the spec to floor it any tighter.
        for (const [cap, v] of Object.entries(disk.invariantOverrides)) {
          this.state.invariantOverrides = { ...(this.state.invariantOverrides ?? {}), [cap]: Math.max(this.state.invariantOverrides?.[cap] ?? 0, v) }
        }
      }
    }
    // A SEAL is not a proposal decision — `--approve-proposal gate/<id>` runs
    // the decision and then copies the triple, records the shas and stamps
    // `sealedAt` — so it must be merged outside the loop above or a runner
    // holding this object would write its pre-seal `authoring` entry back over
    // the seal that just happened. A seal on disk always wins: it is the one
    // fact here that cannot be re-derived (the triple has already moved).
    for (const [id, a] of Object.entries(disk?.authoring ?? {})) {
      if (!a?.sealedAt) continue
      const mine = this.state.authoring?.[id]
      if (mine?.sealedAt) continue
      this.state.authoring = { ...(this.state.authoring ?? {}), [id]: { ...(mine ?? {}), ...a } }
    }
  }
  appendWave(record) { mkdirSync(this.dir, { recursive: true }); appendFileSync(this.wavesPath, JSON.stringify(record) + '\n') }
  /**
   * I2: the wave record is appended BEFORE the verdict is written, so the
   * verdict's own export and the promotion proposal can see the wave they are
   * about. Two of its fields — `verdictSha` and `notified` — are only known
   * once that verdict has been committed and sent, so they are patched back
   * onto the last line here.
   *
   * Rewritten tmp + rename, like `save()`: a crash mid-rewrite leaves the
   * previous waves.jsonl whole rather than a half-written one. If the file is
   * missing or empty there is no last line to rewrite — append instead, so the
   * record is never lost (the whole point of appending it first).
   */
  rewriteLastWave(record) {
    mkdirSync(this.dir, { recursive: true })
    const lines = existsSync(this.wavesPath) ? readFileSync(this.wavesPath, 'utf8').split('\n').filter(Boolean) : []
    if (lines.length === 0) return this.appendWave(record)
    lines[lines.length - 1] = JSON.stringify(record)
    const tmp = `${this.wavesPath}.tmp`
    writeFileSync(tmp, lines.join('\n') + '\n', 'utf8')
    renameSync(tmp, this.wavesPath)
  }
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
