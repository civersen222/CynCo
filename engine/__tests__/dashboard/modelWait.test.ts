/**
 * Two things the phone could not see (work-order mission D4, parts f and g).
 *
 * f. A model that says nothing. The engine may wait twenty minutes for a first token and ten
 *    between tokens before it cuts a request (F235), and through all of it the chat showed
 *    nothing. `/api/session` now carries `modelSilence` and the page says it in words.
 * g. The outcome ledger. Its panel lives on the Governance tab, which the phone does not have.
 *    On the phone the one panel is moved under Away.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function extractFunction(name: string): string {
  const startAt = html.indexOf('function ' + name + '(')
  if (startAt < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = html.indexOf('{', startAt); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(startAt, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

describe('the line that says the model is silent', () => {
  const modelWaitLine = new Function(`${extractFunction('modelWaitLine')}; return modelWaitLine;`)() as (s: any, agoMs: number) => string | null
  const first = (silentMs: number) => ({ phase: 'first-byte', silentMs, limitMs: 1_200_000, server: 'llama-server' })
  const mid = (silentMs: number) => ({ phase: 'mid-stream', silentMs, limitMs: 600_000, server: 'llama-server' })

  it('says nothing when no request is in flight, or when the silence is ordinary', () => {
    expect(modelWaitLine(null, 0)).toBeNull()
    expect(modelWaitLine(undefined, 0)).toBeNull()
    expect(modelWaitLine(first(14_000), 0)).toBeNull() // reading a long prompt takes this long every turn
    expect(modelWaitLine(mid(9_000), 0)).toBeNull()
  })

  it('before the first token: how long, and when the engine gives up', () => {
    expect(modelWaitLine(first(80_000), 0)).toBe('Waiting for the model\'s first token: 1m 20s so far. The engine ends the request after 20m of silence.')
  })

  it('mid-reply: the model has stopped sending', () => {
    expect(modelWaitLine(mid(45_000), 0)).toBe('The model has sent nothing for 45s. The engine ends the request after 10m of silence.')
  })

  it('counts the time since the page was told', () => {
    expect(modelWaitLine(mid(60_000), 5_000)).toBe('The model has sent nothing for 1m 5s. The engine ends the request after 10m of silence.')
    expect(modelWaitLine(first(12_000), 4_000)).toContain('16s so far')
  })

  it('names a server that is not llama-server', () => {
    expect(modelWaitLine({ phase: 'mid-stream', silentMs: 30_000, limitMs: 600_000, server: 'Ollama' }, 0))
      .toBe('Ollama has sent nothing for 30s. The engine ends the request after 10m of silence.')
  })

  it('a frame missing its numbers says nothing rather than "NaN"', () => {
    expect(modelWaitLine({ phase: 'mid-stream' }, 0)).toBeNull()
  })
})

describe('the page asks while a turn runs, and stops saying it when the model speaks', () => {
  it('the poll reads /api/session only while a turn is open, and clears the line otherwise', () => {
    const poll = extractFunction('pollModelWait')
    expect(poll).toContain('chatTurnRunning()')
    expect(poll).toContain("fetch('/api/session')")
    expect(poll.indexOf('chatTurnRunning()')).toBeLessThan(poll.indexOf("fetch('/api/session')"))
    expect(poll).toContain('modelSilence')
  })

  it('the line has its own place in the chat, and is written as text', () => {
    expect(html).toContain('id="chatModelWait"')
    const render = extractFunction('renderModelWait')
    expect(render).toContain("document.getElementById('chatModelWait')")
    expect(render).toContain('.textContent = ')
    expect(render).not.toContain('innerHTML')
  })

  it('a token or a thought from the model takes the line down at once', () => {
    for (const type of ['stream.token', 'stream.thinking']) {
      const at = html.indexOf(`case '${type}':`)
      expect(at, type).toBeGreaterThan(-1)
      expect(html.slice(at, at + 260), type).toContain('clearModelWait()')
    }
  })
})

describe('the outcome ledger on the phone', () => {
  const move = new Function(`${extractFunction('moveMissionHistoryForRemote')}; return moveMissionHistoryForRemote;`)() as (doc: any) => boolean

  function fakeDoc(opts: { panel?: boolean; away?: boolean } = {}) {
    const title = { textContent: 'Missions' }
    const away: any = { children: [] as any[], appendChild(n: any) { if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c: any) => c !== n); n.parentNode = away; away.children.push(n) } }
    const governance: any = { children: [] as any[] }
    const panel: any = { id: 'panelMissionHistory', parentNode: governance, querySelector: (sel: string) => (sel === '.panel-title' ? title : null) }
    governance.children.push(panel)
    return {
      title, away, governance, panel,
      doc: {
        getElementById: (id: string) => (id === 'panelMissionHistory' && opts.panel !== false ? panel : null),
        querySelector: (sel: string) => (sel === '#tab-away .grid' && opts.away !== false ? away : null),
      },
    }
  }

  it('the one panel is moved under Away, not copied: its controls are found by id', () => {
    const f = fakeDoc()
    expect(move(f.doc)).toBe(true)
    expect(f.away.children).toEqual([f.panel])
    expect(f.governance.children).toEqual([])
  })

  it('it is renamed there: the phone\'s Missions tab is the schedules', () => {
    const f = fakeDoc()
    move(f.doc)
    expect(f.title.textContent).toBe('Mission history (every run in the outcome ledger)')
  })

  it('doing it again changes nothing, and a page without the panel or the tab is left alone', () => {
    const f = fakeDoc()
    move(f.doc)
    expect(move(f.doc)).toBe(false)
    expect(f.away.children).toHaveLength(1)
    expect(move(fakeDoc({ panel: false }).doc)).toBe(false)
    expect(move(fakeDoc({ away: false }).doc)).toBe(false)
  })

  it('a mission\'s campaign link narrows the list on the phone, where there is no Campaign panel to open', () => {
    const wire = extractFunction('wireMissionHistory')
    const remote = wire.indexOf('if (window.__CYNCO_REMOTE) {')
    expect(remote).toBeGreaterThan(-1)
    const branch = wire.slice(remote, wire.indexOf('focusCampaign(campaign)'))
    expect(branch).toContain('missionHistory.campaign = campaign')
    expect(branch).toContain('missionHistory.offset = 0')
    expect(branch).toContain('pollMissionHistory()')
    expect(branch).toContain('return;')
  })

  it('there is one such panel in the page, and the phone layout moves it before it decides where to land', () => {
    expect(html.split('id="panelMissionHistory"').length - 1).toBe(1)
    const layout = extractFunction('applyRemoteLayout')
    expect(layout).toContain('moveMissionHistoryForRemote(document)')
    expect(layout.indexOf('moveMissionHistoryForRemote(document)')).toBeLessThan(layout.indexOf('remoteRouteOnce('))
  })
})
