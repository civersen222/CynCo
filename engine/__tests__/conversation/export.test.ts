import { describe, expect, it } from 'bun:test'
import { exportAsMarkdown, exportAsJson, importFromJson } from '../../conversation/export.js'

const messages = [
  { role: 'user' as const, content: [{ type: 'text', text: 'Hello' }] },
  { role: 'assistant' as const, content: [{ type: 'text', text: 'Hi there!' }] },
  { role: 'user' as const, content: [{ type: 'text', text: 'Read foo.ts' }] },
  { role: 'assistant' as const, content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'foo.ts' } }] },
]

describe('Conversation Export', () => {
  it('exports as markdown', () => {
    const md = exportAsMarkdown(messages, { model: 'gemma4:31b', timestamp: '2026-04-15' })
    expect(md).toContain('# Conversation')
    expect(md).toContain('Hello')
    expect(md).toContain('Hi there!')
    expect(md).toContain('gemma4')
  })

  it('exports as JSON', () => {
    const json = exportAsJson(messages, { model: 'gemma4:31b' })
    const parsed = JSON.parse(json)
    expect(parsed.messages).toHaveLength(4)
    expect(parsed.metadata.model).toBe('gemma4:31b')
  })

  it('imports from JSON', () => {
    const json = exportAsJson(messages, { model: 'gemma4:31b' })
    const imported = importFromJson(json)
    expect(imported.messages).toHaveLength(4)
    expect(imported.messages[0].role).toBe('user')
  })

  it('markdown includes tool calls', () => {
    const md = exportAsMarkdown(messages, {})
    expect(md).toContain('Tool:')
    expect(md).toContain('Read')
  })

  it('json export includes version and exportedAt', () => {
    const json = exportAsJson(messages, {})
    const parsed = JSON.parse(json)
    expect(parsed.version).toBe(1)
    expect(parsed.metadata.exportedAt).toBeDefined()
  })
})
