// Where the outcome ledger lives, and how it is split across files.
//
// The ledger is append-only and every record carries a full mission trajectory,
// so it grows about 1 MB per mission. GitHub warns at 50 MB and REFUSES a push
// at 100 MB. `missions.jsonl` reached 58.7 MB at 193 records — already past the
// warning, roughly 34 missions from a hard stop that would have arrived with no
// warning of its own, mid-wave, on a push that had to succeed.
//
// Splitting it is therefore mechanical, but the mechanism matters. The obvious
// scheme — keep `missions.jsonl` as the live file and move old records out to
// archives when it grows — rewrites the live file on a rolling boundary, which
// means the one file every reader depends on is being rewritten at exactly the
// moment a mission is trying to append to it. So this does the opposite:
//
//   - `missions.jsonl` is FROZEN. It holds records 1..193 and is never written
//     to again. Every existing tool that reads only that path keeps reading
//     valid, unrelocated history.
//   - New records go to `missions.0002.jsonl`, then `missions.0003.jsonl`, and
//     so on. Rolling is "start a new file", never "move records between files".
//     No record ever changes shard, so `--record N` numbering over the
//     concatenation stays stable forever.
//
// Order is lexicographic-with-the-bare-name-first, which is also chronological:
// missions.jsonl, missions.0002.jsonl, missions.0003.jsonl, ...

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEDGER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..',
  'benchmark', 'cynco-ledger')

// Roll well under GitHub's 50 MB warning rather than near its 100 MB refusal.
// A shard that merely avoids the hard limit still makes every clone slower and
// still trips the warning on every push; the point is to keep each file small
// enough that neither is ever a question.
const SHARD_MAX_BYTES = 40 * 1024 * 1024

const SHARD_RE = /^missions\.(\d{4})\.jsonl$/

export function shardIndex(name) {
  if (name === 'missions.jsonl') return 1
  const m = SHARD_RE.exec(name)
  return m ? Number(m[1]) : null
}

/** Every shard that exists, in record order. */
export function shardPaths(dir = LEDGER_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, i: shardIndex(name) }))
    .filter((e) => e.i !== null)
    .sort((a, b) => a.i - b.i)
    .map((e) => join(dir, e.name))
}

/**
 * The shard the next record is appended to.
 *
 * Rolls when the newest shard is at or over the cap. Note it does NOT roll on
 * `missions.jsonl` being merely large-for-its-era: that file is already over
 * the cap, so the first call after this lands returns `missions.0002.jsonl`,
 * which is the intent — the frozen head stays frozen.
 */
export function activeShardPath(dir = LEDGER_DIR, maxBytes = SHARD_MAX_BYTES) {
  const shards = shardPaths(dir)
  if (!shards.length) return join(dir, 'missions.jsonl')
  const newest = shards[shards.length - 1]
  if (statSync(newest).size < maxBytes) return newest
  const next = shardIndex(newest.split(/[\\/]/).pop()) + 1
  return join(dir, `missions.${String(next).padStart(4, '0')}.jsonl`)
}

/**
 * Every record across every shard, in order, each tagged with the shard it came
 * from and its position within it. The tag is what lets an editor write back
 * only the shard it touched instead of rewriting 60 MB to change one field.
 */
export function readLedger(dir = LEDGER_DIR) {
  const rows = []
  for (const path of shardPaths(dir)) {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    lines.forEach((line, i) => {
      const rec = JSON.parse(line)
      Object.defineProperty(rec, '__shard', { value: path, enumerable: false })
      Object.defineProperty(rec, '__line', { value: i, enumerable: false })
      rows.push(rec)
    })
  }
  return rows
}

/** How many records the whole ledger holds. */
export function ledgerCount(dir = LEDGER_DIR) {
  let n = 0
  for (const path of shardPaths(dir)) {
    n += readFileSync(path, 'utf8').split('\n').filter(Boolean).length
  }
  return n
}

export function ensureLedgerDir(dir = LEDGER_DIR) {
  mkdirSync(dir, { recursive: true })
}
