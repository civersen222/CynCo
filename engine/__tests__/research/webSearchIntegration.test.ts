import { describe, it, expect } from 'bun:test'
import { webSearchTool } from '../../tools/impl/webSearch.js'

describe('WebSearch tool schema', () => {
  it('has engine parameter in schema', () => {
    const props = webSearchTool.inputSchema.properties as Record<string, any>
    expect(props.engine).toBeDefined()
    expect(props.engine.enum).toContain('auto')
    expect(props.engine.enum).toContain('arxiv')
    expect(props.engine.enum).toContain('wikipedia')
    expect(props.engine.enum).toContain('github')
    expect(props.engine.enum).toContain('pubmed')
    expect(props.engine.enum).toContain('searxng')
    expect(props.engine.enum).toContain('duckduckgo')
  })
  it('defaults engine to auto', () => {
    const props = webSearchTool.inputSchema.properties as Record<string, any>
    expect(props.engine.default).toBe('auto')
  })
  it('query is still required', () => {
    expect(webSearchTool.inputSchema.required).toContain('query')
  })
  it('engine is not required', () => {
    expect(webSearchTool.inputSchema.required).not.toContain('engine')
  })
})
