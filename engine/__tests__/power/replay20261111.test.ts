/**
 * The proof of metasystem slice 1, through the whole path with real processes:
 * the real records of 2026-11-11 (the main PC's System log, the engine's log,
 * the doorman's journal) go through the reporter's own parsers and its outbox
 * to a real watcher (`scripts/doorman/watcher.py`, started here on 127.0.0.1 on
 * a port the OS chooses), and the note that watcher serves must flag the night
 * of F221 and the embedding outage of F215.
 *
 * What is real and what is reconstructed: `scripts/doorman/fixtures/2026-11-11/README.md`.
 * Nothing here touches the doorman, the live engine or any service of this PC.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Outbox } from '../../power/reporter/outbox.js'
import { buildPushes, FIXTURE_DIR } from './replay20261111.fixture.js'

const DOORMAN = join(process.cwd(), 'scripts', 'doorman')

/** A Python 3 on this machine, or null. The watcher needs nothing beyond the standard library. */
function findPython(): string | null {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['-c', 'import sys, sqlite3; print(sys.version_info[0])'], { encoding: 'utf-8', windowsHide: true })
    if (r.status === 0 && String(r.stdout).trim() === '3') return exe
  }
  return null
}

const python = findPython()
if (!python) console.warn('[replay20261111] SKIPPED: no Python 3 on PATH, so the watcher cannot be started here. `python -m pytest scripts/doorman/test_watch_replay.py` is the same replay without the processes.')

const F221_WAKES = [
  '2026-11-11T10:46:46Z', '2026-11-11T11:16:46Z', '2026-11-11T11:47:54Z', '2026-11-11T12:18:02Z',
  '2026-11-11T12:47:55Z', '2026-11-11T13:17:55Z', '2026-11-11T14:02:55Z', '2026-11-11T14:46:47Z',
]

type Finding = { id: string; kind: string; box: string; from: string; to: string; open: boolean; seen: string; expected: string; means: string; suggest: string; marks: string[] }

describe('the fixture is what the reporter produces from the raw records', () => {
  it('pushes.json equals the parsers run over the System log rows, the engine log lines and outage.json', () => {
    const committed = JSON.parse(readFileSync(join(FIXTURE_DIR, 'pushes.json'), 'utf-8'))
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildPushes())))
    expect(committed.records).toHaveLength(26)
  })
})

describe.skipIf(!python)('2026-11-11 replayed through the reporter and a real watcher', () => {
  let watcher: ChildProcess
  let base = ''
  let stderr = ''

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cynco-replay-'))
    // The doorman's own record of the day: its journal, turned into the burst journal the watcher reads.
    const journal = readFileSync(join(FIXTURE_DIR, 'doorman-journal.txt'), 'utf-8')
    const made = spawnSync(python!, [join(DOORMAN, 'journal_bursts.py'), '--targets', join(FIXTURE_DIR, 'targets.json')], { input: journal, encoding: 'utf-8', windowsHide: true })
    expect(made.status, made.stderr).toBe(0)
    const bursts = join(dir, 'bursts.jsonl')
    writeFileSync(bursts, made.stdout.replace(/\r\n/g, '\n'))

    watcher = spawn(python!, [join(DOORMAN, 'watcher.py'), '--bind', '127.0.0.1', '--port', '0', '--db', join(dir, 'watch.db'), '--bursts-file', bursts, '--schedule-file', '', '--tz-offset-min', '-420'], { windowsHide: true })
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the watcher did not say where it listens: ${stderr}`)), 15_000)
      watcher.stderr!.on('data', chunk => {
        stderr += String(chunk)
        const m = /watcher listening on 127\.0\.0\.1:(\d+)/.exec(stderr)
        if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`) }
      })
      watcher.on('exit', code => { clearTimeout(timer); reject(new Error(`the watcher exited with ${code}: ${stderr}`)) })
    })

    // The main PC's side: the reporter's own outbox sends what its parsers made of the day.
    const outbox = new Outbox({ url: base, box: 'main', file: join(dir, 'outbox.jsonl'), batch: 10, log: () => {} })
    outbox.add(buildPushes().records)
    while (outbox.size() > 0) expect(await outbox.flush()).toBe('sent')
    // The watcher reads the doorman's burst journal on its own beat: wait until it has.
    for (let i = 0; i < 100; i++) {
      const page = await (await fetch(`${base}/day/2026-11-11`)).text()
      if (page.includes('Wake bursts it sent')) break
      await new Promise(r => setTimeout(r, 100))
    }
  }, 30_000)

  afterAll(() => { watcher?.kill() })

  const findings = async (day = '2026-11-11'): Promise<Finding[]> => ((await (await fetch(`${base}/findings.json?day=${day}`)).json()) as { findings: Finding[] }).findings

  it('the night of F221 is one finding with exactly its eight wakes; the wake the doorman caused is not in it', async () => {
    const wakes = (await findings()).filter(f => f.kind === 'wake.unexplained')
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ id: 'wake.unexplained:main:2026-11-11', box: 'main' })
    expect(wakes[0]!.marks).toEqual(F221_WAKES)
    expect(wakes[0]!.marks).not.toContain('2026-11-11T10:11:17Z')
    expect(wakes[0]!.seen).toContain('8 times')
    expect(wakes[0]!.seen).toContain('Power Button')
    expect(wakes[0]!.expected).toContain("10:11Z, a scheduled job's wake at 2026-11-11T10:11:09Z")
    for (const part of ['seen', 'expected', 'means', 'suggest'] as const) expect(wakes[0]![part].length).toBeGreaterThan(20)
  })

  it('the embedding outage on 9165 is a finding, from the engine saying so to the recorded restart', async () => {
    const down = (await findings()).filter(f => f.kind === 'service.down')
    expect(down).toHaveLength(1)
    expect(down[0]).toMatchObject({ id: 'service.down:main:embed:2026-11-11T15:06:00Z', from: '2026-11-11T15:06:00Z', to: '2026-11-11T17:18:12Z', open: false })
    expect(down[0]!.seen).toContain('2.2 h')
    expect(down[0]!.seen).toContain('started by hand at 10:18:12 local')
  })

  it('nothing else is flagged that day, and the days around it are quiet', async () => {
    expect((await findings()).map(f => f.kind).sort()).toEqual(['service.down', 'wake.unexplained'])
    expect(await findings('2026-11-10')).toEqual([])
    expect(await findings('2026-11-12')).toEqual([])
  })

  it('the page shows both, marks the flagged times on the chart, and takes no input', async () => {
    const resp = await fetch(`${base}/day/2026-11-11`)
    expect(resp.headers.get('content-type')).toContain('text/html')
    const page = await resp.text()
    expect(page).toContain('Flagged (2)')
    expect(page).toContain('Wakes with nothing behind them')
    expect(page).toContain('A service was not answering')
    expect(page.match(/class="mark"/g)).toHaveLength(9)
    for (const at of F221_WAKES) expect(page).toContain(`(${at})`)
    expect(page).toContain('Wake bursts it sent')
    expect(page).not.toMatch(/<script|<form|<input|<button/i)
  })

  it('sending the same day again stores nothing twice', async () => {
    const resp = await fetch(`${base}/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildPushes()) })
    expect(await resp.json()).toEqual({ ok: true, stored: 0, duplicates: 26, rejected: 0 })
    expect((await findings()).map(f => f.kind).sort()).toEqual(['service.down', 'wake.unexplained'])
  })
})
