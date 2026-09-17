#!/usr/bin/env bun
// scripts/cynco-campaign-adopt.mjs — hand the campaign runner a wave that
// already ran.
//
//   bun scripts/cynco-campaign-adopt.mjs <id>.campaign.json <missionId>
//
// A wave dispatched by hand (or by a runner invocation that died before it
// graded) leaves a complete ledger row and a real commit range, but the
// campaign state knows nothing about it. Adopting the row marks it so the very
// next `cynco-campaign.mjs` invocation starts that wave at GRADE instead of
// dispatching it again: the same measurement, the same verdict entry, the same
// commit — without spending another wall clock re-running work that is already
// in the repo.
//
// It deliberately does NOT touch waveCount. The wave is counted where every
// other wave is counted: by runWave, once it has been graded.
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { cyncoHome } from '../engine/paths.js'
import { loadCampaignSpec } from './cynco-campaign-spec.mjs'
import { CampaignState } from './cynco-campaign-state.mjs'
import { findLedgerRow } from './cynco-ledger-patch.mjs'

export const defaultIo = {
  readRow: (missionId) => findLedgerRow(missionId),
  stateDir: (id) => join(cyncoHome(), 'campaigns', id),
}

/**
 * Write the adoption into the state. Pure enough to argue with in a test:
 * everything that reads the filesystem is in `io`.
 */
export function adopt(state, missionId, row) {
  const base = row?.commitRange?.base
  if (!base) throw new Error(`ledger row ${missionId} has no commitRange.base — it is not a gradeable wave`)
  state.state.adoptedRow = missionId
  // lastBase is what waveContext hands the NEXT brief as its starting point,
  // and what runWave falls back to when the row carries no range of its own.
  state.state.lastBase = base
  state.save()
  return { missionId, base, briefFile: row.briefFile ?? null, waveCount: state.state.waveCount ?? 0 }
}

export function main(argv, io = defaultIo) {
  const specPath = argv.find(a => a.endsWith('.campaign.json'))
  const missionId = argv.find(a => a !== specPath && !a.startsWith('--'))
  if (!specPath || !missionId) {
    console.error('usage: bun scripts/cynco-campaign-adopt.mjs <id>.campaign.json <missionId>')
    return 2
  }
  const spec = loadCampaignSpec(specPath)
  const row = io.readRow(missionId)
  if (!row) { console.error(`[adopt] no ledger row with missionId ${missionId}`); return 2 }
  const dir = io.stateDir(spec.id)
  if (!existsSync(dir)) { console.error(`[adopt] no campaign state at ${dir} — run the campaign once first`); return 2 }
  const state = new CampaignState(dir).load()
  const r = adopt(state, missionId, row)
  console.log(`[adopt] ${spec.id}: wave ${r.waveCount + 1} will GRADE ${r.missionId} (base ${r.base.slice(0, 7)}, brief ${r.briefFile ?? 'unknown'}) instead of dispatching`)
  return 0
}

const isMain = import.meta.main ?? (process.argv[1] ? resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) : false)
if (isMain) process.exit(main(process.argv.slice(2)))
