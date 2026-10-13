/**
 * F179: an image key names the checkpoint the probe picked, so the pick must be
 * current when a RenderUI call's pictures are keyed. The loop warms the image
 * service at the start of every project-chat turn — before the turn's first
 * model call, so the probe has the tens of seconds a turn takes to answer before
 * the final frame is keyed. A coding session paints nothing and never warms;
 * an annotator without `warm` (an older one, a test fake) is left alone; and a
 * warm that throws costs the turn nothing.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject } from '../../projects/layout.js'
import { openBinding } from '../../projects/binding.js'
import { setProjectToolContext } from '../../projects/tools.js'
import { globalContract } from '../../tools/contract.js'
import type { ImageAnnotator } from '../../imagegen/service.js'
import { makeLoop, type Hold, type ScriptBlock } from '../projects/loopScaffold.js'

afterEach(() => {
  setProjectToolContext(null)
  globalContract.clear()
})

const reply: ScriptBlock[][] = [[{ type: 'text', text: 'One.' }], [{ type: 'text', text: 'Two.' }]]

/** A fake annotator whose warm() records how many model calls had gone out when it ran. */
function fake(opts: { throws?: boolean } = {}) {
  const warmAt: number[] = []
  let calls: unknown[] = []
  const images: ImageAnnotator & { warm(): void } = {
    annotate: () => ({ note: null, start: () => {} }),
    warm() {
      warmAt.push(calls.length)
      if (opts.throws) throw new Error('probe bookkeeping exploded')
    },
  }
  return { images, warmAt, bind: (c: unknown[]) => { calls = c } }
}

async function projectLoop(images: ImageAnnotator, script: ScriptBlock[][] = reply, hold?: Hold) {
  const home = mkdtempSync(join(tmpdir(), 'cynco-warm-'))
  const slug = createProject(home, { name: 'Warm', instructions: '' }).slug
  const made = makeLoop({ script, images, hold })
  const b = await openBinding({ home, slug, embed: null, embedModel: 'none', contextLength: 32768 })
  if (!b.ok) throw new Error(b.reason)
  await made.loop.startProjectSession(b.binding, b.messages)
  return made
}

describe('the loop warms the image service at the start of every project-chat turn (F179)', () => {
  it('once per turn, before the turn\'s first model call', async () => {
    const f = fake()
    const made = await projectLoop(f.images)
    f.bind(made.calls)
    await made.loop.handleUserMessage('show me the designs')
    expect(f.warmAt).toEqual([0])
    await made.loop.handleUserMessage('and again')
    expect(f.warmAt).toHaveLength(2)
    expect(f.warmAt[1]).toBe(made.calls.length - 1) // before the second turn's one model call
  }, 60000)

  it('a click delivered at the end of a turn is a new turn and warms again, before its model call', async () => {
    let reached!: () => void
    const atHold = new Promise<void>(r => { reached = r })
    let release!: () => void
    const hold: Hold = { call: 0, reached: () => reached(), release: new Promise<void>(r => { release = r }) }
    const f = fake()
    const made = await projectLoop(f.images, [[{ type: 'text', text: 'Here are the designs.' }], [{ type: 'text', text: 'Design B it is.' }]], hold)
    f.bind(made.calls)
    const turn = made.loop.handleUserMessage('show me the designs')
    await atHold
    made.loop.handleUiAction({ type: 'ui.action', surfaceId: 'designs', action: 'choose', label: 'Choose B', context: { option: 'B' } })
    release()
    await turn
    expect(made.calls).toHaveLength(2) // the click was answered inside the same loop, not re-dispatched
    expect(f.warmAt).toEqual([0, 1])   // once for the typed turn, once for the click, each before its model call
  }, 60000)

  it('a coding session never warms', async () => {
    const f = fake()
    const made = makeLoop({ script: reply, images: f.images })
    f.bind(made.calls)
    await made.loop.handleUserMessage('what is in this repo?')
    expect(f.warmAt).toEqual([])
    expect(made.calls.length).toBeGreaterThan(0)
  }, 60000)

  it('an annotator without warm is left alone, and a warm that throws costs the turn nothing', async () => {
    const plain: ImageAnnotator = { annotate: () => ({ note: null, start: () => {} }) }
    const a = await projectLoop(plain)
    await a.loop.handleUserMessage('show me the designs')
    expect(a.events.some(e => e?.type === 'message.complete')).toBe(true)

    const f = fake({ throws: true })
    const b = await projectLoop(f.images)
    f.bind(b.calls)
    await b.loop.handleUserMessage('show me the designs')
    expect(f.warmAt).toEqual([0])
    expect(b.events.some(e => e?.type === 'message.complete')).toBe(true)
    expect(b.events.some(e => e?.type === 'session.error')).toBe(false)
  }, 60000)
})
