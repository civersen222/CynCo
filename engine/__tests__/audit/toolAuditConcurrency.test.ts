/**
 * The audit's one assumption about the runtime (F242, 03-audit-logs section 2.3.5 rule 3): one
 * append-mode write of one record by one process is never interleaved with another process's, so
 * several processes can share one day file. Three real Bun processes write 500 records of 64 KiB
 * each into one marked temp folder at the same time; afterwards every line parses, every process
 * has its sequence 1 to 501 with no gap, and no line holds bytes of two records. A second case
 * kills a writer hard right after it reported its tenth start: the records it reported are on disk.
 *
 * If the first case ever fails, the fallback is one file per process (`<date>.<proc>.jsonl`); it is
 * not built. Runs wherever `bun` is on the PATH, and says so when it is not.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AUDIT_FILE_RE, AUDIT_MARKER } from '../../audit/toolAudit.js'

const FIXTURE = resolve('engine/__tests__/fixtures/auditAppendMany.ts')

/** The Bun executable itself (not the npm shim), so a hard kill reaches the writer and not a shell. */
function bunExecutable(): string | null {
  // On Windows `bun` on the PATH is an npm shim that only a shell runs; one command string, no args array.
  const r = process.platform === 'win32'
    ? spawnSync('bun -e "console.log(process.execPath)"', { encoding: 'utf-8', shell: true, timeout: 30_000 })
    : spawnSync('bun', ['-e', 'console.log(process.execPath)'], { encoding: 'utf-8', timeout: 30_000 })
  if (r.status !== 0) return null
  const p = r.stdout.trim().split(/\r?\n/).pop() ?? ''
  return p !== '' ? p : null
}
const BUN = bunExecutable()

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 5 }) })

function markedDir(): string {
  const r = mkdtempSync(join(tmpdir(), 'cynco-audit-concurrency-'))
  roots.push(r)
  const dir = join(r, 'audit')
  mkdirSync(dir)
  writeFileSync(join(dir, AUDIT_MARKER), '')
  return dir
}

function writer(dir: string, count: number, bytes: number, startAt: number, slowAfter?: number): ChildProcess {
  const args = [FIXTURE, dir, String(count), String(bytes), String(startAt), ...(slowAfter !== undefined ? [String(slowAfter)] : [])]
  return spawn(BUN!, args, { stdio: ['ignore', 'pipe', 'pipe'] })
}

function finished(c: ChildProcess): Promise<{ code: number | null; out: string; err: string }> {
  let out = '', err = ''
  c.stdout!.on('data', d => { out += String(d) })
  c.stderr!.on('data', d => { err += String(d) })
  return new Promise(res => c.on('close', code => res({ code, out, err })))
}

/** Every line of every day file in `dir`, parsed; a line that does not parse fails the test with its start. */
function records(dir: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = []
  for (const name of readdirSync(dir).filter(n => AUDIT_FILE_RE.test(n) && statSync(join(dir, n)).isFile()).sort()) {
    const text = readFileSync(join(dir, name), 'utf-8')
    expect(text.endsWith('\n'), `${name} does not end with a newline`).toBe(true)
    for (const line of text.split('\n')) {
      if (line === '') continue
      let rec: Record<string, any>
      try {
        rec = JSON.parse(line)
      } catch (e) {
        throw new Error(`${name}: a line does not parse (${(e as Error).message}): ${line.slice(0, 120)}`)
      }
      out.push(rec)
    }
  }
  return out
}

describe.skipIf(BUN === null)('the audit under concurrent writers (skipped when bun is not on the PATH)', () => {
  it('three Bun processes, 500 records of 64 KiB each, one folder: every line whole, every sequence 1 to 501', async () => {
    const dir = markedDir()
    const startAt = Date.now() + 2000
    const runs = await Promise.all([0, 1, 2].map(() => finished(writer(dir, 500, 64 * 1024, startAt))))
    for (const r of runs) expect(r.code, `a writer failed:\n${r.err}`).toBe(0)

    const recs = records(dir)
    const byProc = new Map<string, Array<Record<string, any>>>()
    for (const r of recs) byProc.set(r.proc, [...(byProc.get(r.proc) ?? []), r])
    expect(byProc.size).toBe(3)
    for (const [proc, list] of byProc) {
      const seqs = list.map(r => r.seq as number).sort((a, b) => a - b)
      expect(seqs, `proc ${proc}`).toEqual(Array.from({ length: 501 }, (_, i) => i + 1))
      expect(list.filter(r => r.kind === 'open')).toHaveLength(1)
      const pid = proc.split('-')[0]
      for (const r of list.filter(x => x.kind === 'start')) {
        const cmd: string = r.input.command
        // The record's own pid and index, then one letter only: no bytes of another record.
        const m = /^(\d+):(\d+):([a-z])\3*$/.exec(cmd)
        expect(m, `proc ${proc} seq ${r.seq}: the input is not one record's`).not.toBeNull()
        expect(m![1]).toBe(pid)
        expect(Number(m![2])).toBe(r.seq - 1)
        expect(cmd.length).toBe(64 * 1024)
      }
    }
  }, 240_000)

  it('a writer killed hard right after its tenth start leaves records 1 to 11 (open and ten starts) on disk', async () => {
    const dir = markedDir()
    const c = writer(dir, 100_000, 1024, Date.now(), 10)
    const done = finished(c)
    await new Promise<void>((res, rej) => {
      let seen = ''
      const timer = setTimeout(() => rej(new Error(`the writer did not report ten starts:\n${seen}`)), 60_000)
      c.stdout!.on('data', d => {
        seen += String(d)
        if (/^started 10 /m.test(seen)) {
          clearTimeout(timer)
          // A hard kill: TerminateProcess on Windows (what taskkill /F does), SIGKILL elsewhere.
          c.kill('SIGKILL')
          res()
        }
      })
    })
    const r = await done
    expect(r.out).not.toMatch(/^done /m)
    const recs = records(dir)
    const seqs = new Set(recs.map(x => x.seq as number))
    for (let s = 1; s <= 11; s++) expect(seqs.has(s), `record ${s} is missing`).toBe(true)
    expect(new Set(recs.map(x => x.proc)).size).toBe(1)
  }, 120_000)
})
