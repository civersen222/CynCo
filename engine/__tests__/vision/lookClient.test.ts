import { describe, expect, it } from 'bun:test'
import { LOOK_INSTRUCTION, LOOK_KEEP_ALIVE, LOOK_NUM_CTX, LookClient, makeLookClient, parseLook } from '../../vision/lookClient.js'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function fakeFetch(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; body: any }> = []
  const fn = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) })
    return reply(String(url), init)
  }) as unknown as typeof fetch
  return { fn, calls }
}
const ollamaReply = (content: string) => new Response(JSON.stringify({ model: 'qwen3-vl:8b-instruct', message: { role: 'assistant', content } }), { status: 200 })

describe('parseLook', () => {
  it('splits the three labelled sections in order', () => {
    expect(parseLook('TEXT:\nUEFI: USB, Partition 1\nSTATE:\nsecond line highlighted\nDESCRIPTION:\nA boot menu on a monitor.'))
      .toEqual({ text: 'UEFI: USB, Partition 1', state: 'second line highlighted', description: 'A boot menu on a monitor.' })
  })
  it('tolerates a missing section', () => {
    expect(parseLook('DESCRIPTION: A yard with a fence.')).toEqual({ text: '', state: '', description: 'A yard with a fence.' })
  })
})

describe('LookClient.look', () => {
  it('sends one chat request with the instruction, the image as base64 and a keep_alive of seconds, and returns the parsed look with timing', async () => {
    const f = fakeFetch(() => ollamaReply('TEXT: hello\nSTATE: lit\nDESCRIPTION: a lamp'))
    let t = 1000
    const c = new LookClient({ url: 'http://box:11434', model: 'qwen3-vl:8b-instruct', fetchFn: f.fn, now: () => (t += 2100) })
    const r = await c.look(png, 'image/png')
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].url).toBe('http://box:11434/api/chat')
    const b = f.calls[0].body
    expect(b.model).toBe('qwen3-vl:8b-instruct')
    expect(b.stream).toBe(false)
    expect(b.keep_alive).toBe('5s')
    expect(LOOK_KEEP_ALIVE).toBe('5s')
    // a 12 MP phone photo is ~4100 image tokens on qwen3-vl; Ollama's default 4096 window refused it (F190)
    expect(b.options).toEqual({ num_ctx: LOOK_NUM_CTX })
    expect(LOOK_NUM_CTX).toBe(8192)
    expect(b.messages[0].content).toBe(LOOK_INSTRUCTION)
    expect(b.messages[0].images).toEqual([Buffer.from(png).toString('base64')])
    expect(r).toEqual({ ok: true, look: { text: 'hello', state: 'lit', description: 'a lamp', model: 'qwen3-vl:8b-instruct', ms: 2100 } })
  })
  it('the STATE line asks for the selected or highlighted item on a screen and how to tell (F191: "none" 4/4 on a dense screen)', () => {
    expect(LOOK_INSTRUCTION).toMatch(/which menu item, tab, row or line is selected or highlighted, and how you can tell/)
  })
  it('ask: one chat request with the question, the same window and keep_alive, returning the answer with timing (F191)', async () => {
    const f = fakeFetch(() => ollamaReply('The second item, "Resume", is highlighted.'))
    let t = 1000
    const c = new LookClient({ url: 'http://box:11434', model: 'qwen3-vl:8b-instruct', fetchFn: f.fn, now: () => (t += 1500) })
    const r = await c.ask(png, 'image/png', 'which item is selected?')
    const b = f.calls[0].body
    expect(f.calls[0].url).toBe('http://box:11434/api/chat')
    expect(b.model).toBe('qwen3-vl:8b-instruct'); expect(b.stream).toBe(false); expect(b.keep_alive).toBe(LOOK_KEEP_ALIVE); expect(b.options).toEqual({ num_ctx: LOOK_NUM_CTX })
    expect(b.messages[0].content).toContain('which item is selected?')
    expect(b.messages[0].content).toMatch(/does not show it, say so/)
    expect(b.messages[0].images).toEqual([Buffer.from(png).toString('base64')])
    expect(r).toEqual({ ok: true, answer: 'The second item, "Resume", is highlighted.', model: 'qwen3-vl:8b-instruct', ms: 1500 })
  })
  it('ask: a refused request is a reason, never a throw', async () => {
    const f = fakeFetch(() => new Response('{"error":"boom"}', { status: 500 }))
    const c = new LookClient({ url: 'http://box:11434', model: 'm', fetchFn: f.fn })
    const r = await c.ask(png, 'image/png', 'q')
    expect(r).toEqual({ ok: false, reason: 'image box did not answer: HTTP 500 {"error":"boom"}' })
  })
  it('unload: one /api/generate with keep_alive 0 and no prompt, so Ollama drops the vision model from the box\'s VRAM before a transform (F194)', async () => {
    const f = fakeFetch(() => new Response('{"done":true}', { status: 200 }))
    const c = new LookClient({ url: 'http://box:11434', model: 'qwen3-vl:8b-instruct', fetchFn: f.fn })
    const r = await c.unload()
    expect(r).toEqual({ ok: true })
    expect(f.calls[0].url).toBe('http://box:11434/api/generate')
    expect(f.calls[0].body).toEqual({ model: 'qwen3-vl:8b-instruct', keep_alive: 0 })
    const bad = new LookClient({ url: 'http://box:11434', model: 'm', fetchFn: fakeFetch(() => new Response('x', { status: 500 })).fn })
    expect(await bad.unload()).toEqual({ ok: false, reason: 'image box did not unload the vision model: HTTP 500' })
  })
  it('a server that never answers is a bounded refusal', async () => {
    const f = fakeFetch((_u, init) => new Promise((_res, rej) => { (init.signal as AbortSignal).addEventListener('abort', () => rej(new Error('The operation timed out'))) }))
    const c = new LookClient({ url: 'http://box:11434', model: 'm', fetchFn: f.fn, timeoutMs: 20 })
    const r = await c.look(png, 'image/png')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/^image box did not answer: .*timed out/)
  })
  it('an HTTP error is a refusal naming the status', async () => {
    const f = fakeFetch(() => new Response('boom', { status: 500 }))
    const c = new LookClient({ url: 'http://box:11434', model: 'm', fetchFn: f.fn })
    const r = await c.look(png, 'image/png')
    expect(r).toEqual({ ok: false, reason: 'image box did not answer: HTTP 500 boom' })
  })
})

describe('makeLookClient', () => {
  it('is null without LOCALCODE_VISION_URL and a client with it', () => {
    expect(makeLookClient({})).toBeNull()
    expect(makeLookClient({ LOCALCODE_VISION_URL: 'http://box:11434' })).toBeInstanceOf(LookClient)
  })
})
