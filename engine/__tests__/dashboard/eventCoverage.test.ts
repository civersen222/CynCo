import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

/**
 * The dashboard drops any event its handleEvent switch has no case for —
 * silently, because the default arm is a no-op. `file.diff` was emitted by the
 * engine (bridge/conversationLoop.ts) and rendered by the Textual TUI for the
 * whole of Phase 6, while a browser watching the same session saw Edit tools
 * fire and never saw what changed. Nothing failed; the diff simply fell off the
 * end of a switch.
 *
 * This asserts the events a watcher needs in order to know what the agent did
 * are all handled. It is deliberately a curated list, not "every event the
 * engine can emit" — plenty of events are diagnostics with no place in the UI,
 * and a blanket check would either be noise or force dead cases to be written.
 */
const __dir = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = join(__dir, '../../dashboard/index.html')

const MUST_RENDER = [
  'session.ready',
  'tool.start',
  'tool.complete',
  'file.diff',
  'approval.request',
  'governance.status',
  'context.status',
]

describe('dashboard event coverage', () => {
  const html = readFileSync(INDEX_HTML, 'utf-8')

  for (const type of MUST_RENDER) {
    it(`handles ${type}`, () => {
      expect(html).toContain(`case '${type}'`)
    })
  }

  it('renders file.diff hunks rather than only counting them', () => {
    // A case arm that acknowledged the event without drawing the lines would
    // satisfy the check above and still leave the watcher blind.
    expect(html).toContain('appendChatDiff')
    expect(html).toMatch(/kind === 'add'/)
    expect(html).toMatch(/kind === 'del'/)
  })
})
