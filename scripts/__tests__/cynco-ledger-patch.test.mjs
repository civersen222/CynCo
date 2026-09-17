import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { patchLedgerRow, findLedgerRow } from '../cynco-ledger-patch.mjs'

describe('patchLedgerRow', () => {
  it('merges fields into the right row and rewrites only its shard', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    writeFileSync(join(dir, 'missions.jsonl'), JSON.stringify({ missionId: 'a', verified: null }) + '\n')
    writeFileSync(join(dir, 'missions.0001.jsonl'), [{ missionId: 'b', verified: null }, { missionId: 'c', verified: null }].map(r => JSON.stringify(r)).join('\n') + '\n')
    const r = patchLedgerRow('c', { verified: true, gate: { fails: [] } }, dir)
    expect(r.shard.endsWith('missions.0001.jsonl')).toBe(true)
    expect(findLedgerRow('c', dir)).toMatchObject({ verified: true, gate: { fails: [] } })
    expect(findLedgerRow('b', dir).verified).toBeNull()
    expect(readFileSync(join(dir, 'missions.jsonl'), 'utf8')).toBe(JSON.stringify({ missionId: 'a', verified: null }) + '\n')
  })
  it('throws when the row is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
    writeFileSync(join(dir, 'missions.jsonl'), '')
    expect(() => patchLedgerRow('zzz', { verified: true }, dir)).toThrow(/zzz/)
  })
})
