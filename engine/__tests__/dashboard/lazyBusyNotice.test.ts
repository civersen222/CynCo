// The lazy engine's "GPU busy with <trigger>" notice (governance.alert, source
// llama-cpp, severity info) must reach the CHAT, not only the tool feed, or the
// phone sees up to 30 minutes of silence (wakefulness review #2). The page's
// alertChatLine() decides which alerts become a chat line; it is lifted here by
// text the way the other dashboard tests do.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../dashboard/index.html'), 'utf-8')
function scripts(): string {
  const out: string[] = []
  // `\b[^>]*` on the closing tag too: CodeQL's "bad HTML filtering regexp" check
  // wants `</script\t\n bar>` matched as an end tag, which `\s*>` alone did not.
  const re = /<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) out.push(m[1])
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

describe('alertChatLine', () => {
  const alertChatLine = new Function(`${fnSource('alertChatLine')}; return alertChatLine;`)() as (e: any) => string | null
  it('turns the lazy engine busy notice into a chat line', () => {
    expect(alertChatLine({ type: 'governance.alert', severity: 'info', source: 'llama-cpp', message: 'GPU busy with digest-espn (fantasy-digest) - about 12 min left; the model loads when it ends' }))
      .toBe('model: GPU busy with digest-espn (fantasy-digest) - about 12 min left; the model loads when it ends')
  })
  it('keeps the operator acknowledgement', () => {
    expect(alertChatLine({ type: 'governance.alert', severity: 'low', source: 'operator', message: 'noted' })).toBe('operator: noted')
  })
  it('leaves other alerts to the tool feed', () => {
    expect(alertChatLine({ type: 'governance.alert', severity: 'critical', source: 'llama-cpp', message: 'refused' })).toBeNull()
    expect(alertChatLine({ type: 'governance.alert', severity: 'info', source: 'vsm', message: 'x' })).toBeNull()
    // the image box's look line (design §2 goal 6) rides the same channel
    expect(alertChatLine({ type: 'governance.alert', severity: 'info', source: 'vision', message: 'looked at nas.jpg on the image box (qwen3-vl:8b-instruct, 1.8 s)' })).toBe('image box: looked at nas.jpg on the image box (qwen3-vl:8b-instruct, 1.8 s)')
  })
  it('handleEvent routes governance.alert through alertChatLine', () => {
    expect(fnSource('handleEvent')).toContain('alertChatLine(event)')
  })
})
