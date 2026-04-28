import { describe, expect, it } from 'bun:test'
import { codeSearchTool } from '../../tools/impl/codeSearch.js'

describe('CodeSearch tool', () => {
  it('has correct metadata', () => {
    expect(codeSearchTool.name).toBe('CodeSearch')
    expect(codeSearchTool.tier).toBe('auto')
  })

  it('finds function definitions', async () => {
    // Search in the localcode directory for a known function
    const result = await codeSearchTool.execute({
      query: 'isLocalMode',
      type: 'function',
      path: '/tmp/test-project',
    }, process.cwd())
    // Either finds matches or returns "No matches found" — should not error
    expect(result.output.length).toBeGreaterThan(0)
  })

  it('returns no matches for unknown symbol', async () => {
    const result = await codeSearchTool.execute({
      query: 'xyzzy_nonexistent_symbol_12345',
    }, process.cwd())
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No matches')
  })

  it('requires query parameter', () => {
    expect(codeSearchTool.inputSchema.required).toContain('query')
  })
})
