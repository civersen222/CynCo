// The Missions tab (docs/superpowers/specs/2026-11-08-mission-schedule-control-design.md §4.5): the cadence
// editor's shapes, the next-fire words and one trigger row. Pure page functions, lifted out of index.html by
// brace matching and run for real, the same source the browser loads.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function extractFunction(src: string, name: string): string {
  const start = src.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}
function lift<T>(name: string, deps: string[] = []): T {
  const src = [...deps, name].map((n) => extractFunction(html, n)).join('\n')
  return new Function(`${src}\nreturn ${name};`)() as T
}

const HELPERS = ['escHtml', 'pad2', 'clockText', 'whenText', 'agoText']
const cronFromEditor = lift<(e: any) => any>('cronFromEditor', ['pad2'])
const editorFromTrigger = lift<(t: any) => any>('editorFromTrigger', ['pad2'])
const whenText = lift<(iso: string | null, nowIso: string) => string>('whenText', ['pad2', 'clockText'])
const missionTriggerRow = lift<(t: any, nowIso: string) => string>('missionTriggerRow', HELPERS)

// Sunday 8 Nov 2026, 10:00 local: every expectation is built in the runner's own time zone, like the browser's.
const local = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).toISOString()
const NOW = local(8, 10, 0)

describe('cronFromEditor', () => {
  it('daily stays a daily trigger', () => {
    expect(cronFromEditor({ shape: 'daily', at: '11:15' })).toEqual({ kind: 'daily', at: '11:15' })
  })
  it('every N hours between two times is a stepped cron with the start minute', () => {
    expect(cronFromEditor({ shape: 'every', everyHours: 4, from: '09:25', to: '17:25' })).toEqual({ kind: 'cron', cron: '25 9-17/4 * * *' })
    expect(cronFromEditor({ shape: 'every', everyHours: 2, from: '07:25', to: '21:25' }).cron).toBe('25 7-21/2 * * *')
  })
  it('weekly is a day-of-week cron', () => {
    expect(cronFromEditor({ shape: 'weekly', day: 4, at: '19:45' })).toEqual({ kind: 'cron', cron: '45 19 * * 4' })
  })
  it('advanced passes the hand-written cron through', () => {
    expect(cronFromEditor({ shape: 'advanced', cron: '5 10 * * 2' })).toEqual({ kind: 'cron', cron: '5 10 * * 2' })
  })
  it('an empty advanced field changes no cadence', () => {
    expect(cronFromEditor({ shape: 'advanced', cron: '  ' })).toBeNull()
  })
})

describe('editorFromTrigger', () => {
  it('round-trips the three shapes', () => {
    for (const e of [
      { shape: 'daily', at: '11:15' },
      { shape: 'every', everyHours: 2, from: '07:25', to: '21:25' },
      { shape: 'weekly', day: 4, at: '19:45' },
    ]) expect(editorFromTrigger(cronFromEditor(e))).toEqual(e)
  })
  it('reads a weekly-kind trigger as the weekly shape', () => {
    expect(editorFromTrigger({ kind: 'weekly', day: 'thu', at: '19:45' })).toEqual({ shape: 'weekly', day: 4, at: '19:45' })
  })
  it('anything else is advanced, carrying its cron', () => {
    expect(editorFromTrigger({ kind: 'cron', cron: '0 9 1 * *' })).toEqual({ shape: 'advanced', cron: '0 9 1 * *' })
    expect(editorFromTrigger({ kind: 'interval', everyMinutes: 30 })).toEqual({ shape: 'advanced', cron: '' })
  })
})

describe('whenText', () => {
  it('says today for the same local day', () => { expect(whenText(local(8, 16, 25), NOW)).toBe('today 4:25 PM') })
  it('names the weekday within six days', () => { expect(whenText(local(12, 19, 45), NOW)).toBe('Thu 7:45 PM') })
  it('names the date further out', () => { expect(whenText(local(15, 9, 45), NOW)).toBe('Nov 15 9:45 AM') })
  it('is a dash for nothing', () => { expect(whenText(null, NOW)).toBe('—') })
})

describe('missionTriggerRow', () => {
  const base = {
    id: 'dynasty-tin-trades', name: 'tin trades', kind: 'cron', cron: '25 7-21/2 * * *', cadenceText: 'every 2 hours 7:25 AM–9:25 PM',
    enabled: true, overridden: [], timeoutMs: null, missedPolicy: 'skip', precheck: 'command',
    nextFire: local(8, 11, 25), nextFirePreview: false,
    lastRun: { ts: local(8, 9, 25), ok: true, kind: 'skip', summary: 'skip: gate said nothing new' },
  }
  it('carries the trigger id, the switch state, the dot and the next fire', () => {
    const out = missionTriggerRow(base, NOW)
    expect(out).toContain('data-trigger="dynasty-tin-trades"')
    expect(out).toContain('sw-toggle')
    expect(out).toContain('aria-checked="true"')
    expect(out).toContain('lr-dot skip')
    expect(out).toContain('today 11:25 AM')
    expect(out).toContain('35m ago')
    expect(out).not.toContain('<em>')
    expect(out).not.toContain('edited')
  })
  it('a disabled trigger says off and its switch is unchecked', () => {
    const out = missionTriggerRow({ ...base, enabled: false, nextFire: null }, NOW)
    expect(out).toContain('<span class="mt-next">— off</span>')
    expect(out).toContain('aria-checked="false"')
    expect(missionTriggerRow(base, NOW)).not.toContain('— off')
  })
  it('a preview next fire is in <em>', () => {
    expect(missionTriggerRow({ ...base, nextFirePreview: true }, NOW)).toContain('<em>today 11:25 AM</em>')
  })
  it('an overridden trigger is marked edited with a reset link', () => {
    const out = missionTriggerRow({ ...base, overridden: ['cron'] }, NOW)
    expect(out).toContain('edited')
    expect(out).toContain('data-act="reset"')
  })
  it('no last run is the none dot', () => {
    expect(missionTriggerRow({ ...base, lastRun: null }, NOW)).toContain('lr-dot none')
  })
  it('escapes the summary and the name', () => {
    const out = missionTriggerRow({ ...base, name: 'a<b', lastRun: { ...base.lastRun, kind: 'fail', summary: 'snapshot <b>UNREADABLE</b>' } }, NOW)
    expect(out).toContain('&lt;b&gt;UNREADABLE&lt;/b&gt;')
    expect(out).not.toContain('<b>UNREADABLE')
    expect(out).toContain('a&lt;b')
    expect(out).toContain('lr-dot fail')
  })
})

describe('the poll and an open editor', () => {
  const shouldRender = lift<(open: boolean) => boolean>('missionsListShouldRender')
  it('re-renders the list only while no editor is open', () => {
    expect(shouldRender(false)).toBe(true)
    expect(shouldRender(true)).toBe(false)
  })
  it('renderMissions asks before it touches the list, and no longer moves editor nodes', () => {
    const src = extractFunction(html, 'renderMissions')
    const gate = src.indexOf('missionsListShouldRender(')
    expect(gate).toBeGreaterThan(-1)
    expect(src.indexOf('list.innerHTML')).toBeGreaterThan(gate)
    expect(src).not.toContain('replaceWith')
  })
})

describe('a save racing a poll', () => {
  it('saveTrigger writes the response into the live row, else reloads', () => {
    const src = extractFunction(html, 'saveTrigger')
    expect(src).toContain('liveMissionItem(mid, tid)')
    expect(src).toContain('loadMissions()')
    expect(src).not.toMatch(/item\.querySelector\('\.mt-row'\);\s*\n\s*if \(cur\)/)
  })
  it('a busy row ignores taps', () => {
    expect(html).toMatch(/classList\.contains\('busy'\) && act !== 'last'\) return;/)
  })
})

describe('wiring', () => {
  it('the page has the tab, polls /api/missions and wires pause', () => {
    expect(html).toContain('id="tab-missions"')
    expect(html).toContain("switchTab('missions')")
    expect(html).toContain("fetch('/api/missions')")
    expect(html).toContain("'/api/daemon/pause'")
    expect(html).toMatch(/body\.remote \.mt-row\s*\{[^}]*flex-wrap:\s*wrap/)
  })
  it('switchTab loads missions on entry and stops the poll on leave', () => {
    const src = extractFunction(html, 'switchTab')
    expect(src).toContain("name === 'missions'")
    expect(src).toContain('stopMissionsPoll()')
  })
})
