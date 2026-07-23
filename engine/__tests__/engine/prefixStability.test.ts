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
import { formatSkillIndexBlock } from '../../skills/prompt.js'

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

  it('a load_tools surface breaks the tool-array prefix ONCE while the system prompt is unchanged, then append-only resumes', async () => {
    // Option B (on-demand tool loading): the system prompt <TOOLS> block stays
    // core-only and byte-stable; the *structured* tools array grows on a
    // load_tools surface — one bounded break, like compaction — then both the
    // system prompt and the message tail are append-only again.
    const CORE = TOOLS
    const WEBFETCH = { name: 'web_fetch', description: 'Fetch', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } as any

    // System prompt is built once from CORE and never rewritten.
    const messages: any[] = [msg('user', 'load the web tool')]
    const system = await assembleSystem(messages)

    // Serialize system + structured tools array + messages.
    const serWithTools = (tools: any[], msgs: any[]) =>
      system + '\u0000TOOLS=' + JSON.stringify(tools) + '\u0000' + msgs.map(m => JSON.stringify(m)).join('\u0000')

    // Turn 1: core tools only.
    const before = serWithTools(CORE, messages)

    // Surface event: model called load_tools, WebFetch enters the array AND an
    // availability block is appended to the tail.
    let tools = [...CORE, WEBFETCH]
    messages.push(msg('assistant', 'calling load_tools'))
    messages.push(msg('user', '[tool result] Loaded: WebFetch'))
    messages.push(msg('user', '[tool-availability turn 0] Newly loaded tools:\n- WebFetch: Fetch'))
    const afterSurface = serWithTools(tools, messages)

    // The tool-array prefix breaks once (WebFetch inserted mid-serialization)…
    expect(afterSurface.startsWith(before)).toBe(false)
    // …but the system prompt string itself is byte-identical across the surface.
    expect(await assembleSystem(messages)).toBe(system)

    // Post-surface turns: append-only resumes (tools array stable now).
    const post: string[] = [afterSurface]
    for (let turn = 0; turn < 3; turn++) {
      messages.push(msg('assistant', `post-surface turn ${turn}`))
      messages.push(msg('user', `[tool result] ok`))
      post.push(serWithTools(tools, messages))
    }
    for (let i = 1; i < post.length; i++) {
      expect(post[i].startsWith(post[i - 1])).toBe(true)
    }
  })

  it('the skill-index block is session-static and keeps the system prefix byte-stable across turns', async () => {
    // Skills are discovered once per session. The skill-index block enters the
    // system prompt and must be identical on every turn (no per-turn drift), so
    // the append-only prefix guarantee holds with skills present.
    const index = [
      { name: 'tdd', description: 'TDD loop', source: 'builtin' as const },
      { name: 'debug', description: 'Systematic debugging', source: 'builtin' as const },
    ]
    const withSkills = (msgs: any[]) => {
      const block = formatSkillIndexBlock(index)
      return BASE_SYSTEM + '\n\n' + block + '\u0000' + msgs.map(m => JSON.stringify(m)).join('\u0000')
    }
    const messages: any[] = [msg('user', 'use the tdd skill')]
    const serialized: string[] = []
    for (let turn = 0; turn < 4; turn++) {
      serialized.push(withSkills(messages))
      messages.push(msg('assistant', `turn ${turn}`))
      messages.push(msg('user', `[tool result ${turn}] ok`))
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
