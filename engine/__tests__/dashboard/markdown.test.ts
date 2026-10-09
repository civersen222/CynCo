/**
 * The chat pane's markdown renderer (generative UI, design §5).
 *
 * Assistant prose used to be `textContent` under `white-space: pre-wrap`; it is
 * now rendered by `mdToHtml`, the one place in the page that turns model text
 * into innerHTML. These cases pin the contract that makes that safe: the input
 * is escaped BEFORE any markup is recognised, links keep only http(s) hrefs,
 * and unclosed emphasis/brackets stay literal while a reply is still streaming.
 *
 * No DOM harness: the functions are lifted out of index.html (the same source
 * the browser loads) and run against the page's own `escHtml`.
 */
import { describe, it, expect } from 'bun:test'
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

/** The contiguous markdown section of the page script, between its two headers. */
function markdownSection(): string {
  const js = scripts()
  const start = js.indexOf('// ── Markdown (assistant prose)')
  const end = js.indexOf('// ── Generative UI (RenderUI surfaces)')
  expect(start, 'markdown section header not found').toBeGreaterThan(-1)
  expect(end, 'generative UI section header not found').toBeGreaterThan(start)
  return js.slice(start, end)
}

/** One top-level `function name(` … `}` from the page, by brace matching. */
function fnSource(name: string): string {
  const js = scripts()
  const start = js.indexOf('function ' + name + '(')
  expect(start, `function ${name} not found`).toBeGreaterThan(-1)
  let depth = 0
  for (let i = js.indexOf('{', start); i < js.length; i++) {
    if (js[i] === '{') depth++
    else if (js[i] === '}') { depth--; if (depth === 0) return js.slice(start, i + 1) }
  }
  throw new Error('unbalanced braces for ' + name)
}

const build = new Function(
  fnSource('escHtml') + '\n' + markdownSection() +
  '\nreturn { mdToHtml: mdToHtml, safeUrl: safeUrl, mdInline: mdInline, mdTableRow: mdTableRow };')
const { mdToHtml, safeUrl, mdInline, mdTableRow } = build() as {
  mdToHtml: (s: string) => string; safeUrl: (s: string) => string; mdInline: (s: string) => string; mdTableRow: (s: string) => string[]
}

describe('dashboard markdown: the page defines the renderer', () => {
  it('defines safeUrl, mdInline, mdTableRow, mdToHtml and mdToHtmlEscaped in the markdown section', () => {
    const section = markdownSection()
    for (const fn of ['safeUrl', 'mdInline', 'mdTableRow', 'mdToHtml', 'mdToHtmlEscaped']) {
      expect(section).toContain(`function ${fn}(`)
    }
  })

  it('assistant prose goes through mdToHtml with the raw text kept in data-raw', () => {
    const append = fnSource('appendChatMsg')
    expect(append).toContain("role === 'assistant'")
    expect(append).toContain("div.setAttribute('data-raw'")
    expect(append).toContain('div.innerHTML = mdToHtml(text)')
    // the stream arm appends to data-raw and re-renders once per animation frame
    const js = scripts()
    expect(js).toContain('mdStreamAppend(lastEl, event.text)')
    expect(fnSource('mdScheduleRender')).toContain('requestAnimationFrame(mdFlushStream)')
    expect(fnSource('mdScheduleRender')).toContain('else mdFlushStream()')
    // message.complete flushes a render still queued
    expect(js).toContain('mdFlushStream();')
    // the save-as-artifact snippet and the empty check read the raw text, not the rendered preview
    expect(fnSource('markSaveableReplies')).toContain("div.getAttribute('data-raw')")
    expect(fnSource('saveAsArtifact')).toContain("div.getAttribute('data-raw')")
    expect(fnSource('saveAsArtifact')).not.toContain('div.textContent.trim().slice(0, 120)')
  })

  it('replaces pre-wrap on .chat-msg-assistant with block styles for markdown and the genui Markdown block', () => {
    expect(html).not.toMatch(/\.chat-msg-assistant\s*\{[^}]*white-space:\s*pre-wrap/)
    for (const sel of ['.chat-msg-assistant p, .genui-md p', '.chat-msg-assistant pre, .genui-md pre',
      '.chat-msg-assistant table, .genui-md table', '.chat-msg-assistant blockquote, .genui-md blockquote',
      '.chat-msg-assistant hr, .genui-md hr', '.chat-msg-assistant a, .genui-md a']) {
      expect(html).toContain(sel)
    }
  })
})

describe('mdToHtml', () => {
  it('paragraphs and soft breaks', () => {
    expect(mdToHtml('a\nb\n\nc')).toBe('<p>a<br>b</p><p>c</p>')
  })
  it('headings', () => {
    expect(mdToHtml('# T\n## U\n#### V')).toBe('<h1>T</h1><h2>U</h2><h4>V</h4>')
    expect(mdToHtml('##### not')).toBe('<p>##### not</p>')
  })
  it('inline', () => {
    expect(mdToHtml('**b** *i* _j_ `c` ~~s~~')).toBe('<p><strong>b</strong> <em>i</em> <em>j</em> <code>c</code> <del>s</del></p>')
    expect(mdToHtml('snake_case_name stays')).toBe('<p>snake_case_name stays</p>')
    expect(mdToHtml('2*3*4')).toBe('<p>2*3*4</p>')
  })
  it('code fences, with and without a closing fence, no inline markup inside', () => {
    expect(mdToHtml('```ts\nconst a = **x**;\n```\nafter')).toBe('<pre><code class="lang-ts">const a = **x**;</code></pre><p>after</p>')
    expect(mdToHtml('```\nopen **still**')).toBe('<pre><code>open **still**</code></pre>')
  })
  it('lists, nested one level, task items', () => {
    expect(mdToHtml('- a\n- b\n  - c\n- d')).toBe('<ul><li>a</li><li>b<ul><li>c</li></ul></li><li>d</li></ul>')
    expect(mdToHtml('1. x\n2. y')).toBe('<ol><li>x</li><li>y</li></ol>')
    expect(mdToHtml('- [ ] todo\n- [x] done')).toContain('<li class="task done">')
  })
  it('tables', () => {
    expect(mdToHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
    expect(mdToHtml('| a | b |\nnot a table')).toBe('<p>| a | b |<br>not a table</p>')
  })
  it('blockquote and rule', () => {
    expect(mdToHtml('> q **b**\n> more')).toBe('<blockquote><p>q <strong>b</strong><br>more</p></blockquote>')
    expect(mdToHtml('---')).toBe('<hr>')
  })
  it('links: only http(s), labels escaped, autolinks', () => {
    expect(mdToHtml('[x](https://a.b/c?d=1&e=2)')).toBe('<p><a href="https://a.b/c?d=1&amp;e=2" target="_blank" rel="noopener noreferrer">x</a></p>')
    expect(mdToHtml('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>')
    expect(mdToHtml('see https://a.b/c.')).toBe('<p>see <a href="https://a.b/c" target="_blank" rel="noopener noreferrer">https://a.b/c</a>.</p>')
  })
  it('escapes HTML first: no tag from the model survives', () => {
    expect(mdToHtml('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(mdToHtml('**<script>**')).toBe('<p><strong>&lt;script&gt;</strong></p>')
    expect(mdToHtml('[<b>x</b>](https://a.b)')).toBe('<p><a href="https://a.b" target="_blank" rel="noopener noreferrer">&lt;b&gt;x&lt;/b&gt;</a></p>')
    expect(mdToHtml('`<i>`')).toBe('<p><code>&lt;i&gt;</code></p>')
    const tricky = mdToHtml('[x](https://a.b" onclick="alert(1))')
    expect(tricky).not.toMatch(/onclick="/)
    expect(tricky).not.toMatch(/<a [^>]*onclick/)
    expect(mdToHtml('see https://a.b"x')).toBe('<p>see <a href="https://a.b" target="_blank" rel="noopener noreferrer">https://a.b</a>&quot;x</p>')
  })
  it('unclosed emphasis stays literal (streaming)', () => {
    expect(mdToHtml('**bold start')).toBe('<p>**bold start</p>')
    expect(mdToHtml('[label](https://a')).toBe('<p>[label](https://a</p>')
  })
  it('safeUrl', () => {
    expect(safeUrl('https://x.y/z')).toBe('https://x.y/z')
    expect(safeUrl('HTTP://x.y')).toBe('HTTP://x.y')
    expect(safeUrl('javascript:alert(1)')).toBe('')
    expect(safeUrl('data:text/html,<b>')).toBe('')
    expect(safeUrl('https://x.y/a b')).toBe('')
  })
  it('empty and null input', () => {
    expect(mdToHtml('')).toBe('')
    expect(mdToHtml(null as unknown as string)).toBe('')
  })
  it('mdInline on escaped text and mdTableRow cells (used by the genui Text and Table paths)', () => {
    expect(mdInline('a **b** `c`')).toBe('a <strong>b</strong> <code>c</code>')
    expect(mdTableRow('| a | b |')).toEqual(['a', 'b'])
    expect(mdTableRow('a|b')).toEqual(['a', 'b'])
  })
  it('the page escHtml is restored after a blockquote renders (mdToHtmlEscaped swaps it temporarily)', () => {
    mdToHtml('> q')
    expect(mdToHtml('<b>')).toBe('<p>&lt;b&gt;</p>')
  })
})

describe('streamed assistant prose renders at most once per animation frame', () => {
  /** A bubble as the stream arm sees it: data-raw plus the rendered innerHTML. */
  function bubble() {
    const attrs: Record<string, string> = {}
    return {
      innerHTML: '', renders: 0,
      parentNode: { scrollTop: 0, scrollHeight: 99 },
      getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
      setAttribute: (k: string, v: string) => { attrs[k] = v },
    }
  }
  function pageWith(raf: ((fn: () => void) => void) | undefined) {
    const make = new Function('requestAnimationFrame', fnSource('escHtml') + '\n' + markdownSection() +
      '\nreturn { mdStreamAppend: mdStreamAppend, mdScheduleRender: mdScheduleRender, mdFlushStream: mdFlushStream };')
    return make(raf) as { mdStreamAppend: (d: unknown, t: string) => void; mdScheduleRender: (d: unknown) => void; mdFlushStream: () => void }
  }

  it('with requestAnimationFrame: tokens accumulate in data-raw and one frame renders them all', () => {
    const frames: (() => void)[] = []
    const page = pageWith(fn => { frames.push(fn) })
    const a = bubble()
    page.mdStreamAppend(a, '# Ti')
    page.mdStreamAppend(a, 'tle\n\n**bo')
    page.mdStreamAppend(a, 'ld**')
    expect(a.getAttribute('data-raw')).toBe('# Title\n\n**bold**')
    expect(a.innerHTML).toBe('')
    expect(frames).toHaveLength(1)
    frames[0]()
    expect(a.innerHTML).toBe('<h1>Title</h1><p><strong>bold</strong></p>')
    expect(a.parentNode.scrollTop).toBe(99)
    // a second bubble starting inside the same frame does not eat the first one's tail
    const b = bubble()
    page.mdStreamAppend(a, ' tail')
    b.setAttribute('data-raw', 'second')
    page.mdScheduleRender(b)
    expect(frames).toHaveLength(2)
    frames[1]()
    expect(a.innerHTML).toBe('<h1>Title</h1><p><strong>bold</strong> tail</p>')
    expect(b.innerHTML).toBe('<p>second</p>')
  })

  it('without requestAnimationFrame the render is immediate; mdFlushStream renders what a frame still owes', () => {
    const page = pageWith(undefined)
    const a = bubble()
    page.mdStreamAppend(a, 'now')
    expect(a.innerHTML).toBe('<p>now</p>')
    const frames: (() => void)[] = []
    const queued = pageWith(fn => { frames.push(fn) })
    const c = bubble()
    queued.mdStreamAppend(c, 'pending')
    expect(c.innerHTML).toBe('')
    queued.mdFlushStream() // what message.complete does
    expect(c.innerHTML).toBe('<p>pending</p>')
    frames[0]() // the late frame finds nothing left to do
    expect(c.innerHTML).toBe('<p>pending</p>')
  })
})

/** How many anchors opened, and every href value. */
function anchorsOf(out: string): { opens: number; hrefs: string[] } {
  return { opens: (out.match(/<a /g) ?? []).length, hrefs: [...out.matchAll(/href="([^"]*)"/g)].map(m => m[1]) }
}

// Final review (security lens): the autolink pass once ran over the href the
// link pass had just written and put a second anchor inside its quotes, so
// model text could add attributes, an event handler included, to an <a>.
describe('mdInline never re-processes the markup it generated', () => {
  it('a link URL holding "(" and a second URL never puts an anchor inside an href', () => {
    for (const md of [
      '[x](https://a.example/p(https://b.example/data-probe=1)',
      'see [docs](https://a.example/p(https://b.example/onmouseover=location=/javascript:alert%281%29/.source//) here',
      '[see https://b.example/x](https://a.example/y)',
    ]) {
      const out = mdToHtml(md)
      const { opens, hrefs } = anchorsOf(out)
      expect(opens, out).toBe(1)
      for (const h of hrefs) expect(h, out).not.toMatch(/[<>"]/)
      // The anchor's attributes, read the way a parser would: quoted values
      // blanked out, so URL text inside href cannot pass for an attribute.
      const tag = out.match(/<a [^>]*>/)![0].replace(/"[^"]*"/g, '""')
      expect([...tag.matchAll(/\s([a-z-]+)=/g)].map(m => m[1]), out).toEqual(['href', 'target', 'rel'])
    }
  })

  it('emphasis never runs over generated tags: target="_blank" and underscores in URLs survive', () => {
    const pep = mdToHtml('See [PEP 8](https://peps.python.org/pep-0008/): use a trailing underscore, e.g. class_ or type_.')
    expect(pep).toContain('target="_blank"')
    expect(pep).toContain('class_ or type_')
    expect(mdToHtml('[static](https://site.dev/_static_/app.js)')).toContain('href="https://site.dev/_static_/app.js"')
    expect(mdToHtml('_see [the docs](https://x.y/a) for details_')).toBe('<p><em>see <a href="https://x.y/a" target="_blank" rel="noopener noreferrer">the docs</a> for details</em></p>')
    expect(mdToHtml('[**bold** label](https://x.y)')).toBe('<p><a href="https://x.y" target="_blank" rel="noopener noreferrer"><strong>bold</strong> label</a></p>')
  })
})
