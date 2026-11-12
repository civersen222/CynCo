/**
 * What the main PC's reporter would have pushed for 2026-11-11, built from that
 * day's real records by the reporter's own parsers
 * (`scripts/doorman/fixtures/2026-11-11/README.md` says where each came from).
 *
 *   bun engine/__tests__/power/replay20261111.fixture.ts --write
 *
 * writes `pushes.json` beside the raw records; `replay20261111.test.ts` fails
 * when the committed file is not what this builds, so the fixture cannot drift
 * from the parsers.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { logLineEvents } from '../../power/reporter/logTail.js'
import { powerEventsFromRows, type SystemLogRow } from '../../power/reporter/powerEvents.js'
import type { PushBody, WatchEvent } from '../../power/reporter/types.js'

export const FIXTURE_DIR = join(process.cwd(), 'scripts', 'doorman', 'fixtures', '2026-11-11')

type Outage = { service: string; saidDown: { at: string; timeIs: string; basis: string }; back: { at: string; timeIs: string; basis: string } }

export function buildPushes(dir: string = FIXTURE_DIR): PushBody {
  const rows = JSON.parse(readFileSync(join(dir, 'system-log.json'), 'utf-8')) as SystemLogRow[]
  const outage = JSON.parse(readFileSync(join(dir, 'outage.json'), 'utf-8')) as Outage
  // Split on \n only, as a reader of a real log would: the parser, not this builder, is what must
  // not care whether the file has CRLF endings (F231).
  const excerpt = readFileSync(join(dir, 'engine-log-excerpt.txt'), 'utf-8').split('\n')

  // Real: the System log, through the parser the reporter runs.
  const power = powerEventsFromRows(rows)

  // Real words, anchored time: the engine's own log line, read as the reporter reads it. The log
  // has no times, so "when it was read" is the anchor `outage.json` gives, and the event says so.
  const said = logLineEvents(excerpt, new Date(outage.saidDown.at)).map(e => ({ ...e, data: { ...e.data, timeIs: outage.saidDown.timeIs, basis: outage.saidDown.basis } }))

  // Reconstructed: no log line records the service coming back. F215 recorded the time it was started by hand.
  const backIso = new Date(outage.back.at).toISOString()
  const back: WatchEvent = {
    t: 'event', at: backIso, kind: 'service.said_up', key: `embed-up:${outage.back.at}`,
    data: { service: outage.service, by: 'the engine', reconstructed: true, timeIs: outage.back.timeIs, basis: outage.back.basis },
  }

  return { v: 1, box: 'main', sentAt: '2026-11-11T17:20:00.000Z', records: [...power, ...said, back] }
}

if (import.meta.main && process.argv.includes('--write')) {
  const body = buildPushes()
  writeFileSync(join(FIXTURE_DIR, 'pushes.json'), JSON.stringify(body, null, 2) + '\n', 'utf-8')
  console.log(`wrote ${body.records.length} records to ${join(FIXTURE_DIR, 'pushes.json')}`)
}
