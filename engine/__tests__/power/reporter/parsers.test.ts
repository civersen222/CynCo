/**
 * The reporter's parsers: the box's own records (the System log, nvidia-smi,
 * the engine log, runs.jsonl) into what the watcher is pushed. The System log
 * rows and the engine log lines are the real ones of 2026-11-11
 * (`scripts/doorman/fixtures/2026-11-11/`).
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { powerEventsFromRows, readSystemLog, sleepReason, systemLogScript, wakeSource, type SystemLogRow } from '../../../power/reporter/powerEvents.js'
import { parseGpuQuery, readGpus } from '../../../power/reporter/gpu.js'
import { FileTail, logLineEvents } from '../../../power/reporter/logTail.js'
import { JobTails, jobEvents } from '../../../power/reporter/jobs.js'
import { toSecond } from '../../../power/reporter/types.js'

const FIXTURE = join(process.cwd(), 'scripts', 'doorman', 'fixtures', '2026-11-11')
const rows: SystemLogRow[] = JSON.parse(readFileSync(join(FIXTURE, 'system-log.json'), 'utf-8'))

describe('the System log of 2026-11-11 as power events', () => {
  const events = powerEventsFromRows(rows)
  const of = (kind: string) => events.filter(e => e.kind === kind)

  it('gives the nine sleeps and the nine wakes the log shows, each wake with the sleep it ended', () => {
    const wakes = of('power.wake')
    expect(wakes.map(w => toSecond(w.at))).toEqual([
      '2026-11-11T10:11:17Z', '2026-11-11T10:46:46Z', '2026-11-11T11:16:46Z', '2026-11-11T11:47:54Z', '2026-11-11T12:18:02Z',
      '2026-11-11T12:47:55Z', '2026-11-11T13:17:55Z', '2026-11-11T14:02:55Z', '2026-11-11T14:46:47Z',
    ])
    expect(of('power.sleep').map(s => toSecond(s.at))).toEqual(wakes.map(w => toSecond(String(w.data.sleepAt))))
    expect(toSecond(String(wakes[1]!.data.sleepAt))).toBe('2026-11-11T10:31:40Z')
  })

  it('says why the box slept (the idle timer, every time) and what Windows named as the wake source', () => {
    expect(new Set(of('power.sleep').map(s => s.data.reason))).toEqual(new Set(['idle']))
    const sources = of('power.wake').map(w => w.data.source)
    expect(sources[0]).toBe('Device -USB4(TM) Host Router (Microsoft)')
    // F221: eight wakes by network traffic, all named "Power Button". The reporter passes the words on and judges nothing.
    expect(sources.slice(1)).toEqual(Array(8).fill('Power Button'))
  })

  it('gives the three restarts of the update as three shutdowns and three boots', () => {
    expect(of('power.shutdown').map(e => toSecond(e.at))).toEqual(['2026-11-11T09:47:06Z', '2026-11-11T09:48:14Z', '2026-11-11T09:49:15Z'])
    expect(of('power.boot').map(e => toSecond(e.at))).toEqual(['2026-11-11T09:47:31Z', '2026-11-11T09:48:45Z', '2026-11-11T09:49:41Z'])
  })

  it('keys every event by what it is and when, so the same rows read twice are the same events', () => {
    expect(powerEventsFromRows(rows)).toEqual(events)
    expect(new Set(events.map(e => `${e.kind}|${e.key}`)).size).toBe(events.length)
    expect(events.find(e => e.kind === 'power.wake')!.key).toBe('wake:2026-11-11T10:11:17Z')
  })
})

describe('powerEventsFromRows on rows that are not the usual shape', () => {
  const trouble = (sleep: string, wake: string, extra: Record<string, string> = {}): SystemLogRow =>
    ({ id: 1, provider: 'Microsoft-Windows-Power-Troubleshooter', at: wake, data: { SleepTime: sleep, WakeTime: wake, WakeSourceType: '1', WakeSourceText: '', ...extra } })

  it('a wake with no Kernel-Power 42 beside it still gives both events, with no reason', () => {
    const got = powerEventsFromRows([trouble('2026-11-12T05:00:00.0000000Z', '2026-11-12T05:30:00.0000000Z')])
    expect(got.map(e => e.kind)).toEqual(['power.sleep', 'power.wake'])
    expect(got[0]!.data.reason).toBeNull()
  })

  it('a sleep whose wake is not written up yet is reported from the 42 alone, and not twice once it is', () => {
    const entering: SystemLogRow = { id: 42, provider: 'Microsoft-Windows-Kernel-Power', at: '2026-11-12T05:00:03.500Z', data: { Reason: '4' } }
    const alone = powerEventsFromRows([entering])
    expect(alone).toEqual([{ t: 'event', at: '2026-11-12T05:00:03.500Z', kind: 'power.sleep', key: 'sleep:2026-11-12T05:00:03Z', data: { reason: 'application' } }])
    const both = powerEventsFromRows([entering, trouble('2026-11-12T05:00:00.0000000Z', '2026-11-12T05:30:00.0000000Z')])
    expect(both.filter(e => e.kind === 'power.sleep')).toHaveLength(1)
    expect(both[0]!.data.reason).toBe('application')
  })

  it('rows it does not know, and rows with no usable time, are left out', () => {
    expect(powerEventsFromRows([
      { id: 1, provider: 'Microsoft-Windows-Kernel-General', at: '2026-11-12T05:00:00Z', data: {} }, // "the system time has changed": same id, another provider
      { id: 107, provider: 'Microsoft-Windows-Kernel-Power', at: '2026-11-12T05:00:00Z', data: {} },
      trouble('never', '2026-11-12T05:30:00Z'),
      { id: 12, provider: 'Microsoft-Windows-Kernel-General', at: 'never', data: {} },
    ])).toEqual([])
  })

  it('words the reasons and sources it knows and names the ones it does not', () => {
    expect([sleepReason('7'), sleepReason('4'), sleepReason('2'), sleepReason(undefined)]).toEqual(['idle', 'application', 'reason 2', null])
    expect(wakeSource({ WakeSourceType: '6', WakeSourceText: '', WakeTimerOwner: 'Windows Update' })).toBe('Timer - Windows Update')
    expect(wakeSource({ WakeSourceType: '0' })).toBe('Unknown')
    expect(wakeSource({ WakeSourceType: '9', WakeSourceText: 'x' })).toBe('type 9 x')
  })
})

describe('reading the System log', () => {
  it('the script has no double quote in it and refuses a time that is not one', () => {
    const s = systemLogScript('2026-11-11T09:00:00.000Z')
    expect(s).not.toContain('"')
    expect(s).toContain('Get-WinEvent')
    expect(s).not.toMatch(/Clear-|Remove-|Set-|New-|Start-|Stop-/)
    expect(() => systemLogScript("2026'; Stop-Computer; '")).toThrow()
  })

  it('reads one row, many rows and no rows, and a failed read is null, not an empty log', async () => {
    const one = JSON.stringify({ record: 5, id: 12, provider: 'Microsoft-Windows-Kernel-General', at: '2026-11-12T05:00:00Z', data: { StartTime: '2026-11-12T05:00:00Z', BootMode: 0 } })
    expect(await readSystemLog('2026-11-12T00:00:00Z', async () => one)).toEqual([{ record: 5, id: 12, provider: 'Microsoft-Windows-Kernel-General', at: '2026-11-12T05:00:00Z', data: { StartTime: '2026-11-12T05:00:00Z', BootMode: '0' } }])
    expect(await readSystemLog('2026-11-12T00:00:00Z', async () => `[${one},${one},"junk",{"id":"x"}]`)).toHaveLength(2)
    expect(await readSystemLog('2026-11-12T00:00:00Z', async () => '  ')).toEqual([])
    const said: string[] = []
    expect(await readSystemLog('2026-11-12T00:00:00Z', async () => { throw new Error('timed out') }, l => said.push(l))).toBeNull()
    expect(said[0]).toContain('could not read the System log: timed out')
  })
})

describe('nvidia-smi', () => {
  const gpu = 'GPU-aaaa, 0, NVIDIA GeForce RTX 5090, 39, 30732, 32607, 0\r\n'
  const apps = [
    'GPU-aaaa, 2312, [Insufficient Permissions]',
    'GPU-aaaa, 5764, C:\\Windows\\explorer.exe',
    'GPU-aaaa, 34280, C:\\Users\\civer\\.cynco\\bin\\llama-server.exe',
    'GPU-aaaa, 40620, C:\\Users\\civer\\.cynco\\bin-brain\\llama-server.exe',
    'GPU-aaaa, 35112, C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'GPU-bbbb, 1, C:\\elsewhere\\other.exe',
  ].join('\n')

  it('reads the card and reduces the processes on it to unique image names', () => {
    expect(parseGpuQuery(gpu, apps)).toEqual([
      { i: 0, name: 'NVIDIA GeForce RTX 5090', tempC: 39, memUsedMib: 30732, memTotalMib: 32607, utilPct: 0, procs: ['explorer.exe', 'firefox.exe', 'llama-server.exe'] },
    ])
  })

  it('a reading the card does not give is null, and an answer with no card is null', () => {
    expect(parseGpuQuery('GPU-aaaa, 0, GTX 1070 Ti, [N/A], 100, 8192, [N/A]', '')![0]).toMatchObject({ tempC: null, memUsedMib: 100, utilPct: null, procs: [] })
    expect(parseGpuQuery('NVIDIA-SMI has failed because it could not communicate with the driver', '')).toBeNull()
    expect(parseGpuQuery('', apps)).toBeNull()
  })

  it('no nvidia-smi is null; a process list that cannot be read still reports the card', async () => {
    expect(await readGpus(async () => { throw new Error('ENOENT') })).toBeNull()
    const got = await readGpus(async args => { if (args[0]!.includes('compute-apps')) throw new Error('denied'); return gpu })
    expect(got).toHaveLength(1)
    expect(got![0]!.procs).toEqual([])
  })
})

describe('the engine log', () => {
  const excerpt = readFileSync(join(FIXTURE, 'engine-log-excerpt.txt'), 'utf-8').split('\n')
  const seen = new Date('2026-11-11T15:06:00Z')

  it('the real lines of 2026-11-11 hold one thing the watcher should know: the engine said embeddings did not answer', () => {
    const got = logLineEvents(excerpt, seen)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ kind: 'service.said_down', at: '2026-11-11T15:06:00.000Z', key: 'embed-down:2026-11-11T15:06:00Z', data: { service: 'embed', by: 'the engine', url: 'http://127.0.0.1:9165' } })
    expect(String(got[0]!.data.text)).toContain('No embedding endpoint answered')
  })

  it('reads the back line, and the blocked line with the time of day the line itself carries', () => {
    const got = logLineEvents([
      '[embed] the embedding endpoint at http://127.0.0.1:9165 answers again — semantic search is back on',
      '[engine] the event loop was blocked for 6.0 s, until 00:58:05Z: nothing was answered meanwhile (the dashboard, the phone, a Stop). What ran is in the lines just above.',
      '[embed] chat told: Semantic search is back: the embedding server answers again.',
    ], new Date('2026-11-12T00:58:20Z'))
    expect(got.map(e => e.kind)).toEqual(['service.said_up', 'engine.loop_blocked'])
    expect(got[1]).toMatchObject({ at: '2026-11-12T00:58:05.000Z', key: 'blocked:2026-11-12T00:58:05Z', data: { seconds: 6, until: '2026-11-12T00:58:05Z' } })
  })

  it('a blocked line read just after midnight belongs to the evening before', () => {
    const got = logLineEvents(['[engine] the event loop was blocked for 1.1 s, until 23:59:58Z: nothing was answered meanwhile'], new Date('2026-11-12T00:00:10Z'))
    expect(got[0]!.at).toBe('2026-11-11T23:59:58.000Z')
  })
})

describe('FileTail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cynco-tail-'))

  it('starts at the end of a file it has never looked at, then reads only whole new lines', () => {
    const file = join(dir, 'a.log')
    writeFileSync(file, 'old 1\nold 2\n')
    const tail = new FileTail(file)
    expect(tail.read()).toEqual([])
    appendFileSync(file, 'new 1\r\nnew 2\nhalf')
    expect(tail.read()).toEqual(['new 1', 'new 2'])
    expect(tail.read()).toEqual([])
    appendFileSync(file, ' done\n')
    expect(tail.read()).toEqual(['half done'])
  })

  it('reads a replaced (shorter) file from its start, takes up where a saved offset left it, and a missing file is nothing', () => {
    const file = join(dir, 'b.log')
    writeFileSync(file, 'one\ntwo\nthree\n')
    const tail = new FileTail(file, 4)
    expect(tail.read()).toEqual(['two', 'three'])
    writeFileSync(file, 'fresh\n')
    expect(tail.read()).toEqual(['fresh'])
    expect(new FileTail(join(dir, 'none.log')).read()).toEqual([])
  })
})

describe('scheduled-job runs', () => {
  const line = (ts: string, ok: boolean, summary = 'Published the card') => JSON.stringify({ ts, triggerId: 'digest-bronze-card', ok, summary, recommendationIds: [] })

  it('a run is one event at the time it ran; a torn or foreign line is skipped; the summary is cut', () => {
    const got = jobEvents('fantasy-digest', [line('2026-11-11T22:05:36.180Z', true, 'x'.repeat(500)), '{"ts":"2026-11-11T23', '', '{"hello":1}', line('2026-11-12T01:45:57.995Z', false)])
    expect(got.map(e => [e.at, e.data.ok])).toEqual([['2026-11-11T22:05:36.180Z', true], ['2026-11-12T01:45:57.995Z', false]])
    expect(got[0]!.key).toBe('fantasy-digest/digest-bronze-card/2026-11-11T22:05:36.180Z')
    expect(String(got[0]!.data.summary)).toHaveLength(160)
    expect(got[0]!.data).toMatchObject({ mission: 'fantasy-digest', triggerId: 'digest-bronze-card' })
  })

  it('tails every mission folder from where it left off', () => {
    const missions = mkdtempSync(join(tmpdir(), 'cynco-missions-'))
    mkdirSync(join(missions, 'fantasy-digest'))
    mkdirSync(join(missions, 'mfl-dynasty'))
    writeFileSync(join(missions, 'fantasy-digest', 'runs.jsonl'), line('2026-11-10T22:00:00.000Z', true) + '\n')
    const tails = new JobTails(missions, { 'fantasy-digest': 0 })
    expect(tails.read().map(e => e.at)).toEqual(['2026-11-10T22:00:00.000Z']) // a saved offset of 0: read from the start
    appendFileSync(join(missions, 'fantasy-digest', 'runs.jsonl'), line('2026-11-11T22:00:00.000Z', true) + '\n')
    writeFileSync(join(missions, 'mfl-dynasty', 'runs.jsonl'), line('2026-11-11T23:00:00.000Z', false) + '\n') // first seen now: starts at its end
    expect(tails.read().map(e => e.at)).toEqual(['2026-11-11T22:00:00.000Z'])
    expect(Object.keys(tails.positions()).sort()).toEqual(['fantasy-digest', 'mfl-dynasty'])
    expect(new JobTails(join(missions, 'none')).read()).toEqual([])
  })
})
