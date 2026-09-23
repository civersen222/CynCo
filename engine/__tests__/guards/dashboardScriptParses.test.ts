/**
 * The dashboard's inline script must PARSE.
 *
 * F150. A review fix wave wrote `fails.join('` + a literal newline + `')` into
 * the Campaign panel — a JS string cannot span a line — and that single
 * SyntaxError takes the whole `<script>` block with it: no websocket, no chat,
 * no Governance panel, no Campaign panel. The page still serves 200 and still
 * renders its HTML shell, so nothing downstream notices.
 *
 * Nothing caught it. Every dashboard guard in this repo is either a source-TEXT
 * check (`eventCoverage.test.ts` asserts a `case` arm is present as a string)
 * or extracts ONE function and runs it (`governancePoll.test.ts`) — both of
 * which are perfectly happy inside a file the browser will refuse to parse.
 *
 * So: parse every inline block, whole. This is the cheapest possible check and
 * it is the one that was missing.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
const INDEX_HTML = join(__dir, '../../dashboard/index.html')

type Block = { startLine: number; body: string; attrs: string }

/** Every `<script …>…</script>` in the file, with the line its tag opens on. */
function inlineScripts(html: string): Block[] {
  const out: Block[] = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? ''
    // `src` blocks have no body of their own; a non-JS type (importmap,
    // text/template) is not script for the parser either.
    if (/\bsrc\s*=/i.test(attrs)) continue
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase()
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue
    out.push({ attrs, body: m[2], startLine: html.slice(0, m.index).split('\n').length })
  }
  return out
}

describe('dashboard index.html: every inline script parses', () => {
  const html = readFileSync(INDEX_HTML, 'utf-8')
  const blocks = inlineScripts(html)

  it('finds the inline script at all — an empty sweep would pass vacuously', () => {
    expect(blocks.length, 'no inline <script> found in index.html').toBeGreaterThan(0)
    // The dashboard is one big inline block; if it is ever split, this still
    // passes and every piece below is checked individually.
    expect(blocks.some(b => b.body.length > 1000)).toBe(true)
  })

  for (const [i, block] of blocks.entries()) {
    it(`block ${i + 1} (line ${block.startLine}) has no syntax error`, () => {
      let error: string | null = null
      try {
        // Compiles the body without running it. A SyntaxError anywhere in the
        // block throws here, exactly as the browser's parser would refuse it.
        new Function(block.body)
      } catch (e) {
        error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      }
      expect(error, `index.html <script> opening at line ${block.startLine} does not parse — ` +
        `the browser drops the ENTIRE block, so the dashboard loads with no behaviour at all. ${error}`).toBeNull()
    })
  }
})
