import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * Review Important #2. `/api/governance` serves CyberneticsGovernance.getReport(),
 * which carries `status`, `health`, `tokPerSec` and friends but NONE of the five
 * fields the Governance panel's new rows read — `invariants`, `routing`, `brain`,
 * `posiwidLive`, `ultrastable`. Those ride only the per-model-call
 * `governance.status` frame. While `pollGovernance` did `state.governance = data`
 * every 3 s, all five rows blanked from the first poll after each frame until the
 * next one — i.e. for the whole of any tool call longer than 3 s, which is every
 * KEEP-GREEN run. The panel is the 2c deliverable, so this pins the merge.
 *
 * index.html has no module boundary, so the function is lifted out of the file by
 * brace matching and run for real against a stubbed fetch — the same source the
 * browser loads, not a copy of it.
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = join(__dir, '../../dashboard/index.html')

function extractFunction(html: string, name: string): string {
  const start = html.indexOf('function ' + name + '(')
  if (start < 0) throw new Error('function ' + name + ' not found in index.html')
  let depth = 0
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') { depth--; if (depth === 0) return html.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

describe('dashboard governance poll', () => {
  const html = readFileSync(INDEX_HTML, 'utf-8')

  it('keeps the status-frame-only fields across a poll that does not carry them', async () => {
    const src = extractFunction(html, 'pollGovernance')
    const state: { governance: Record<string, unknown> | null } = { governance: null }
    let rendered = 0
    const pollPayload = { status: 'ok', health: 'healthy', tokPerSec: 42, varietyRatio: 0.5 }
    const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve(pollPayload) })
    const build = new Function('state', 'fetch', 'render', src + '\nreturn pollGovernance')
    const pollGovernance = build(state, fakeFetch, () => { rendered++ }) as () => void

    // What `case 'governance.status'` does: state.governance = event.
    state.governance = {
      status: 'ok',
      health: 'healthy',
      routing: { count: 3, byKind: { revert: 2 }, byOutcome: { passed: 3 } },
      invariants: { configuration: 'armed', denialCount: 1 },
      brain: { tier: 'live', layerConvergence: { meanAgree: 0.1, meanDepth: 4, n: 9 } },
      posiwidLive: { verdict: 'Consistent' },
      ultrastable: { margin: 0.75 },
    }

    pollGovernance()
    await new Promise((r) => setTimeout(r, 0))

    expect(rendered).toBe(1)
    const gov = state.governance as Record<string, any>
    expect(gov.routing).toEqual({ count: 3, byKind: { revert: 2 }, byOutcome: { passed: 3 } })
    expect(gov.invariants.denialCount).toBe(1)
    expect(gov.brain.tier).toBe('live')
    expect(gov.posiwidLive.verdict).toBe('Consistent')
    expect(gov.ultrastable.margin).toBe(0.75)
    // and the poll's own fields still land
    expect(gov.tokPerSec).toBe(42)
    expect(gov.varietyRatio).toBe(0.5)
  })

  it('merges into a fresh object rather than mutating the frame in place', async () => {
    const src = extractFunction(html, 'pollGovernance')
    const state: { governance: Record<string, unknown> | null } = { governance: null }
    const frame = { status: 'ok', routing: { count: 1 } }
    const fakeFetch = () => Promise.resolve({ json: () => Promise.resolve({ status: 'ok', tokPerSec: 7 }) })
    const pollGovernance = new Function('state', 'fetch', 'render', src + '\nreturn pollGovernance')(
      state, fakeFetch, () => {},
    ) as () => void
    state.governance = frame
    pollGovernance()
    await new Promise((r) => setTimeout(r, 0))
    expect((frame as Record<string, unknown>).tokPerSec).toBeUndefined()
    expect((state.governance as Record<string, unknown>).tokPerSec).toBe(7)
  })

  it('the governance.status case arm still assigns the whole frame', () => {
    // If the arm ever started merging too, a stale `routing` from a previous
    // mission would outlive the session that produced it.
    expect(html).toMatch(/case 'governance\.status':\s*\r?\n\s*state\.governance = event;/)
  })
})
