/**
 * Wave 15 (NOW.md:249): `/compact` compacts. It used to send the model an ordinary message asking for a
 * bullet summary, which compacted nothing and added a turn. It now runs the loop's one compaction path
 * and says what it freed. Wave 15b (check P1-C1): wave 15 reached the loop's private `compactNow` after
 * reading `isProcessing` once, so a message sent during the summary query started a turn whose messages
 * the compaction then threw away. engine/main.ts now calls the loop's public `compactOnRequest`, which
 * refuses while a turn runs and holds the busy state for the whole compaction; its behaviour is pinned by
 * engine/__tests__/bridge/compactOnRequest.test.ts on the real loop. engine/main.ts is the engine's entry
 * and cannot be imported, so its case is read as text, the way the wiring guards read it.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const main = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'main.ts'), 'utf-8').replace(/\r\n/g, '\n')
const loopSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bridge', 'conversationLoop.ts'), 'utf-8').replace(/\r\n/g, '\n')

function compactCase(): string {
  const at = main.indexOf("case '/compact':")
  expect(at, "engine/main.ts has a case '/compact'").toBeGreaterThan(-1)
  const next = main.indexOf('\n        case ', at + 1)
  return main.slice(at, next)
}

describe('/compact', () => {
  it('runs the loop\'s public compaction and sends the model nothing', () => {
    const c = compactCase()
    expect(c).toContain("await loop.compactOnRequest('/compact')")
    expect(c).not.toContain('handleUserMessage(')
  })
  it('reaches no private member of the loop, and leaves the busy rule to the loop (no check of its own that a turn could pass between)', () => {
    const c = compactCase()
    expect(c).not.toMatch(/loop\[['"]/)
    expect(c).not.toContain('compactNow')
    expect(c).not.toContain('loop.isProcessing')
  })
  it('says why when it was refused, what it freed, or why nothing was compacted, and ends the message', () => {
    const c = compactCase()
    expect(c).toContain('answer.refused !== null')
    expect(c).toContain('[System] Nothing was compacted: ${answer.refused}.')
    expect(c).toContain('[System] Compacted: about ${answer.tokensBefore} -> ${answer.tokensAfter} tokens, ${answer.messagesBefore} -> ${answer.messagesAfter} messages.')
    expect(c).toContain('[System] Nothing was compacted (${answer.messagesBefore} messages')
    expect(c).toContain("type: 'message.complete'")
  })
  it('says each text in its own arm: the refusal when refused, what it freed when it compacted, why not otherwise (check CB1-R5)', () => {
    // Wave 15c: the case above finds each text somewhere in the case, so two arms swapped (a real compaction
    // reported as nothing compacted, and the reverse) or tokens printed where messages are meant still passed it.
    const c = compactCase()
    expect(c).toMatch(new RegExp([
      String.raw`answer\.refused !== null\s*\?\s*` + '`' + String.raw`\[System\] Nothing was compacted: \$\{answer\.refused\}\.\\n` + '`',
      String.raw`\s*:\s*answer\.compacted\s*\?\s*` + '`' + String.raw`\[System\] Compacted: about \$\{answer\.tokensBefore\} -> \$\{answer\.tokensAfter\} tokens, \$\{answer\.messagesBefore\} -> \$\{answer\.messagesAfter\} messages\.\\n` + '`',
      String.raw`\s*:\s*` + '`' + String.raw`\[System\] Nothing was compacted \(\$\{answer\.messagesBefore\} messages: too few to compact`,
    ].join('')))
  })
  it('the loop has the public method and the answer fields the case reads', () => {
    expect(loopSrc).toMatch(/\n {2}async compactOnRequest\(label: string\): Promise<CompactAnswer>/)
    for (const f of ['refused: string | null', 'compacted: boolean', 'tokensBefore: number', 'tokensAfter: number', 'messagesBefore: number', 'messagesAfter: number']) {
      expect(loopSrc).toContain(f)
    }
  })
})
