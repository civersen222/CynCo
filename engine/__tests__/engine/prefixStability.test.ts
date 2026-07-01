// engine/__tests__/engine/prefixStability.test.ts
// THE append-only guarantee for llama.cpp checkpoint caching: the serialized
// prompt for turn N must be a byte-prefix of turn N+1. Any feature that
// mutates the system prompt or earlier messages breaks warm-turn TTFT and
// must fail here. Legitimate exception: compaction (rare, accepted).
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildSimulatedToolPrompt } from '../../ollama/simulated.js'
import { getSessionExtras, resetSessionExtras } from '../../engine/sessionExtras.js'
import { buildGovernanceSignal } from '../../vsm/governanceSignal.js'
import { ContextCompressor } from '../../context/compressor.js'

const TOOLS = [
  { name: 'read_file', description: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'run_shell', description: 'Run', input_schema: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
] as any

const BASE_SYSTEM = 'You are CynCo, a local coding assistant.'

function msg(role: 'user' | 'assistant' | 'system', text: string) {
  return { role, content: [{ type: 'text', text }] } as any
}

/** Mirrors callModel assembly: sim tool prompt + base system + session extras. */
async function assembleSystem(messages: any[]): Promise<string> {
  const simPrompt = buildSimulatedToolPrompt(TOOLS)
  let system = simPrompt + '\n\n' + BASE_SYSTEM
  const firstUser = messages.find((m: any) => m.role === 'user')
  const key = firstUser?.content?.map((b: any) => b.text || '').join(' ') ?? ''
  system += await getSessionExtras(key, messages.length <= 2, async () => '\n\n## Recalled Memories\n- prior work on the parser')
  return system
}

function serialize(system: string, messages: any[]): string {
  return system + '\u0000' + messages.map(m => JSON.stringify(m)).join('\u0000')
}

describe('prompt prefix stability across turns', () => {
  beforeEach(() => resetSessionExtras())

  it('turn N serialization is a byte-prefix of turn N+1 across 6 turns incl. a stuck-governance event', async () => {
    const messages: any[] = [msg('user', 'fix the parser bug')]
    const serialized: string[] = []

    for (let turn = 0; turn < 6; turn++) {
      // Governance signal fires as an APPENDED message at stuck >= 3
      const stuck = turn // escalates: null, null, null, warn, warn, critical
      const signal = buildGovernanceSignal(stuck)
      if (signal) messages.push(msg('user', signal))

      const system = await assembleSystem(messages)
      serialized.push(serialize(system, messages))

      // Model "responds" and a tool result lands — pure appends
      messages.push(msg('assistant', `turn ${turn}: reading file`))
      messages.push(msg('user', `[tool result ${turn}] contents...`))
    }

    for (let i = 1; i < serialized.length; i++) {
      expect(serialized[i].startsWith(serialized[i - 1])).toBe(true)
    }
  })

  it('compaction may break the prefix ONCE, then stability resumes', async () => {
    const compressor = new ContextCompressor({ threshold: 0.75, targetRatio: 0.5, keepRecent: 2 })
    let messages: any[] = [msg('user', 'long running task')]
    for (let i = 0; i < 11; i++) messages.push(msg(i % 2 === 0 ? 'assistant' : 'user', `filler-${i}`))

    const before = serialize(await assembleSystem(messages), messages)

    // Compaction event — legitimate one-time prefix break
    messages = compressor.compressMessages(messages, 'compact summary')
    const afterCompaction = serialize(await assembleSystem(messages), messages)
    expect(afterCompaction.startsWith(before)).toBe(false) // break is expected

    // Post-compaction turns must be append-only again
    const post: string[] = [afterCompaction]
    for (let turn = 0; turn < 3; turn++) {
      messages.push(msg('assistant', `post-compact turn ${turn}`))
      messages.push(msg('user', `[tool result] ok`))
      post.push(serialize(await assembleSystem(messages), messages))
    }
    for (let i = 1; i < post.length; i++) {
      expect(post[i].startsWith(post[i - 1])).toBe(true)
    }
  })
})
