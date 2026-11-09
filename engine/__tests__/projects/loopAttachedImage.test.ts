// The image box, design §2 — "see in the moment": a photo attached from the
// phone is in the model's context on the very next turn, even when the look is
// still in flight when the user hits Send (final review C1: the upload must tell
// the loop about the pending picture, and the loop must wait, bounded).
import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { RETRIEVAL_TAG } from '../../projects/retrieval.js'
import { getProjectToolContext, setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import { PENDING_REASON } from '../../vision/lookRunner.js'
import type { Look } from '../../vision/lookClient.js'
import type { IngestEvent } from '../../projects/ingest.js'
import { makeLoop } from './loopScaffold.js'

afterEach(() => { setProjectToolContext(null); globalContract.clear() })

const look: Look = { text: 'LAN1 LAN2 STATUS', state: 'LAN1 green, LAN2 dark, STATUS blinking orange', description: 'The back of a NAS with two network ports.', model: 'qwen3-vl:8b-instruct', ms: 1800 }

/** A runner whose look lands `afterMs` after `pending` is first asked for; `recent` is null until then. */
function fakeRunner(slug: string, rel: string, afterMs: number | null) {
  let done: Look | null = null
  let promise: Promise<IngestEvent> | null = null
  return {
    slug,
    start() {},
    asks: [] as string[],
    async ask(_b: Uint8Array, _m: string, q: string) { this.asks.push(q); return { ok: true as const, answer: 'A', model: 'm', ms: 1 } },
    pending(s: string, r: string) {
      if (s !== slug || r !== rel || afterMs === null) return null
      promise ??= new Promise<IngestEvent>(res => setTimeout(() => { done = look; res({ slug, filePath: `knowledge/${rel}`, kind: 'knowledge', indexed: true, chunks: 2 }) }, afterMs))
      return promise
    },
    recent(s: string, r: string) { return s === slug && r === rel ? done : null },
  }
}

const systemTexts = (msgs: any[]) => msgs.filter(m => m.role === 'system').map(m => String(m.content[0]?.text ?? ''))

describe('an attached photo reaches the next turn', () => {
  it('the loop waits on the in-flight look and puts what the box read at the top of the knowledge block; the pending record itself is not listed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-look-')); const slug = createProject(home, { name: 'NAS' }).slug
    writeFileSync(join(home, slug, 'knowledge', 'nas.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1]))
    const runner = fakeRunner(slug, 'nas.jpg', 40)
    const { loop, calls } = makeLoop({ script: [[{ type: 'text', text: 'LAN2 is dark.' }]] })
    const broadcasts: any[] = []
    ;(loop as any).dashboardBroadcast = (m: any) => broadcasts.push(m)
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768, looks: runner as any })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    // the LookAt tool reaches the same runner (F191)
    const ask = getProjectToolContext()?.ask
    expect(typeof ask).toBe('function')
    await ask!(new Uint8Array([1]), 'image/png', 'what is lit?')
    expect(runner.asks).toEqual(['what is lit?'])
    // What the upload route emits the moment the bytes are written (before the look):
    loop.noteProjectIngest({ slug, filePath: 'knowledge/nas.jpg', kind: 'knowledge', indexed: false, reason: PENDING_REASON })
    await loop.handleUserMessage('which port is dead?')
    const sys = systemTexts(calls[0].messages as any[]).filter(t => t.startsWith(RETRIEVAL_TAG))
    const block = sys.find(t => t.includes('[Attached image] knowledge/nas.jpg'))
    expect(block, sys.join('\n---\n')).toBeDefined()
    expect(block).toContain('text: LAN1 LAN2 STATUS')
    expect(block).toContain('state: LAN1 green')
    expect(sys.join('\n')).not.toContain(PENDING_REASON)
    expect(broadcasts.some(m => m.type === 'governance.alert' && m.source === 'vision' && /looked at nas\.jpg/.test(m.message))).toBe(true)
  })

  it('a look that never comes back: the model is told it cannot see the picture and must say so; the chat is told too', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cynco-look-')); const slug = createProject(home, { name: 'NAS' }).slug
    writeFileSync(join(home, slug, 'knowledge', 'dark.jpg'), Buffer.from([0xff, 0xd8, 0xff, 2]))
    const runner = fakeRunner(slug, 'dark.jpg', null)
    const { loop, calls } = makeLoop({ script: [[{ type: 'text', text: 'I cannot see it.' }]] })
    const broadcasts: any[] = []
    ;(loop as any).dashboardBroadcast = (m: any) => broadcasts.push(m)
    const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768, looks: runner as any })
    if (!b.ok) throw new Error(b.reason)
    await loop.startProjectSession(b.binding, b.messages)
    loop.noteProjectIngest({ slug, filePath: 'knowledge/dark.jpg', kind: 'knowledge', indexed: false, reason: PENDING_REASON })
    await loop.handleUserMessage('what is this?')
    const sys = systemTexts(calls[0].messages as any[]).join('\n')
    // F190: silence here sent the model on a 20-iteration ImageView/Bash spree to see the file itself
    expect(sys).toContain('[Attached image] knowledge/dark.jpg')
    expect(sys).toContain('could not look at it')
    expect(sys).not.toContain('text:')
    expect(broadcasts.some(m => m.source === 'vision' && /did not answer/.test(m.message))).toBe(true)
  })
})
