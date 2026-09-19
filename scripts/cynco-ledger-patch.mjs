import { writeFileSync, renameSync } from 'node:fs'
import { readLedger } from './cynco-ledger-shards.mjs'

export function findLedgerRow(missionId, dir) {
  const rows = dir === undefined ? readLedger() : readLedger(dir)
  return rows.find(r => r.missionId === missionId) ?? null
}

// One row, one shard rewritten (cynco-ledger-sweep.mjs:158-196 pattern): every
// byte rewritten is a byte that can come back different.
export function patchLedgerRow(missionId, fields, dir) {
  const rows = dir === undefined ? readLedger() : readLedger(dir)
  const rec = rows.find(r => r.missionId === missionId)
  if (!rec) throw new Error(`no ledger record with missionId ${missionId}`)
  const before = JSON.parse(JSON.stringify(rec))
  Object.assign(rec, fields)
  const shard = rec.__shard
  const out = rows.filter(r => r.__shard === shard).map(r => JSON.stringify(r)).join('\n') + '\n'
  const tmp = shard + '.tmp'
  writeFileSync(tmp, out)
  renameSync(tmp, shard)
  return { shard, before, after: JSON.parse(JSON.stringify(rec)) }
}
