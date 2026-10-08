/**
 * The AskUser card on the Chat tab (projects-fix-1 A).
 *
 * The first live project session asked the user a question through AskUser and
 * the page had no `ask.request` arm: the question was never shown, the
 * broker's 300 s timer resolved '' and the model went on to save two artifacts
 * nobody asked for. This pins the arm, the answer frame, and that a withdrawn
 * or timed-out question does not leave an answerable card behind.
 *
 * No DOM harness: the page's own functions run against small stubs.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')

function scripts(): string {
  const out: string[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[2])
  return out.join('\n')
}

function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  const close = /\r?\n\}\r?\n/.exec(js.slice(start))
  expect(close).not.toBeNull()
  return js.slice(start, start + close!.index + close![0].length)
}

/** A card stub: attributes, classes, removable parts, appended status lines. */
function makeCard(open: boolean) {
  const attrs: Record<string, string> = { 'data-open': open ? '1' : '0' }
  const classes = new Set<string>(['chat-approval', 'chat-ask'])
  const appended: { textContent: string }[] = []
  const removed: string[] = []
  const card: any = {
    getAttribute: (k: string) => attrs[k] ?? null,
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    classList: { add: (c: string) => classes.add(c) },
    querySelectorAll: () => [
      { parentNode: { removeChild: () => removed.push('ap-btns') } },
      { parentNode: { removeChild: () => removed.push('ask-free') } },
    ],
    appendChild: (el: any) => appended.push(el),
  }
  return { card, attrs, classes, appended, removed }
}

function harness(cards: any[], wsOpen = true) {
  const sent: Record<string, unknown>[] = []
  const said: string[] = []
  const document = {
    querySelector: (sel: string) => {
      const m = /data-ask="([^"]+)"/.exec(sel)
      return cards.find(c => c.id === m?.[1])?.card ?? null
    },
    querySelectorAll: (sel: string) => (sel.includes('data-open="1"') ? cards.filter(c => c.attrs['data-open'] === '1').map(c => c.card) : []),
    createElement: () => ({ className: '', textContent: '' }),
  }
  const make = new Function('document', 'ws', 'appendChatMsg', 'brainViz',
    fnSource('answerAsk') + fnSource('resolveAskCard') + fnSource('closeOpenAskCards') +
    '\nreturn { answerAsk: answerAsk, closeOpenAskCards: closeOpenAskCards };')
  const page = make(
    document,
    { readyState: wsOpen ? 1 : 3, send: (s: string) => sent.push(JSON.parse(s)) },
    (_role: string, text: string) => said.push(text),
    { setActive: () => {} },
  )
  return { page, sent, said }
}

describe('dashboard: the AskUser card', () => {
  it('handles ask.request in handleEvent and answers with ask.answer', () => {
    const js = scripts()
    expect(js).toContain("case 'ask.request'")
    expect(js).toContain('appendAskCard(event)')
    expect(js).toContain("type: 'ask.answer'")
    expect(fnSource('appendAskCard')).toContain("escHtml(event.question || '')")
    expect(fnSource('appendAskCard')).toContain('ask-input')
  })

  it('an option or typed answer sends ask.answer once and collapses the card to "You answered"', () => {
    const c = { id: 'r1', ...makeCard(true) }
    const h = harness([c])
    h.page.answerAsk('r1', 'Front lawn')
    expect(h.sent).toEqual([{ type: 'ask.answer', requestId: 'r1', answer: 'Front lawn' }])
    expect(c.attrs['data-open']).toBe('0')
    expect(c.classes.has('resolved')).toBe(true)
    expect(c.removed).toEqual(['ap-btns', 'ask-free'])
    expect(c.appended.map(e => e.textContent)).toEqual(['You answered: Front lawn'])
    // a second click on a collapsed card sends nothing
    h.page.answerAsk('r1', 'again')
    expect(h.sent).toHaveLength(1)
  })

  it('no socket: nothing is sent, the card stays open and the user is told', () => {
    const c = { id: 'r1', ...makeCard(true) }
    const h = harness([c], false)
    h.page.answerAsk('r1', 'x')
    expect(h.sent).toEqual([])
    expect(c.attrs['data-open']).toBe('1')
    expect(h.said[0]).toContain('Not connected')
  })

  it('an AskUser tool.complete while the card is open marks it withdrawn and disables it', () => {
    const open = { id: 'r1', ...makeCard(true) }
    const answered = { id: 'r0', ...makeCard(false) }
    const h = harness([open, answered])
    h.page.closeOpenAskCards('Question withdrawn before the user answered (the user switched to another conversation).')
    expect(open.attrs['data-open']).toBe('0')
    expect(open.appended[0].textContent).toBe('withdrawn — Question withdrawn before the user answered (the user switched to another conversation).')
    expect(answered.appended).toEqual([])
    expect(h.sent).toEqual([])
  })

  it('a timed-out question closes the card too', () => {
    const open = { id: 'r1', ...makeCard(true) }
    const h = harness([open])
    h.page.closeOpenAskCards('No answer from the user (timed out). Proceed using your best judgment.')
    expect(open.attrs['data-open']).toBe('0')
    expect(open.appended[0].textContent).toContain('withdrawn')
  })

  /** toolResultText as the page defines it. */
  function resultText(event: Record<string, unknown>): string {
    return new Function(fnSource('toolResultText') + '\nreturn toolResultText;')()(event)
  }

  it('the tool.complete arm reads `result` — the field protocol.ts ToolCompleteEvent carries — not `output`', () => {
    const js = scripts()
    expect(js).toContain("if (name === 'AskUser') closeOpenAskCards(toolResultText(event))")
    expect(js).toContain('chatDetail.textContent = toolResultText(event).slice(0, 2000)')
    expect(js).not.toContain('event.output')
    expect(resultText({ type: 'tool.complete', result: 'the answer' })).toBe('the answer')
    expect(resultText({ type: 'tool.complete', output: 'not a field the engine sends' })).toBe('')
    expect(resultText({ type: 'tool.complete', result: { ok: 1 } })).toBe('{"ok":1}')
    expect(resultText({ type: 'tool.complete' })).toBe('')
  })

  it('a withdrawn AskUser result, read off the real frame, puts the withdrawn text on the card', () => {
    const open = { id: 'r1', ...makeCard(true) }
    const h = harness([open])
    const frame = { type: 'tool.complete', toolId: 't1', toolName: 'AskUser', isError: true,
      result: 'Question withdrawn before the user answered (the user switched to another conversation).' }
    h.page.closeOpenAskCards(resultText(frame))
    expect(open.attrs['data-open']).toBe('0')
    expect(open.appended[0].textContent).toBe('withdrawn — Question withdrawn before the user answered (the user switched to another conversation).')
  })

  it('a repeated ask.request for a requestId that already has a card draws nothing', () => {
    const appended: unknown[] = []
    const msgs = { appendChild: (n: unknown) => appended.push(n) }
    const make = new Function('document', 'closeChatThinking', 'escHtml', fnSource('appendAskCard') + '\nreturn appendAskCard;')
    const append = make({
      getElementById: () => msgs,
      querySelector: (sel: string) => (sel === '.chat-ask[data-ask="r1"]' ? {} : null),
    }, () => {}, (s: string) => s)
    append({ type: 'ask.request', requestId: 'r1', question: 'again?' })
    expect(appended).toEqual([])
  })
})
